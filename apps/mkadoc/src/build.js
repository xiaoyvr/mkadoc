import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config.js'
import { decideMode } from './decide-mode.js'
import { loadDependencyGraph } from './deps.js'
import { copyFileIfChanged, relToRoot, walkDir, writeIfChanged } from './fs-utils.js'
import { defaultPoolConcurrency, mapPool } from './map-pool.js'
import { resetPageMetaCache } from './meta-cache.js'
import { assemblePage } from './page.js'
import { createHosts } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'
import { createSession } from './session.js'
import { writeSiteIndex } from './sitemap.js'
import { listSourcePages, pageToOutRel, sourceForRepoPath } from './sources.js'
import { writeThemeCss } from './theme.js'

export async function build(cfg, opts = {}) {
  // One explicit session per CLI invocation, or the serve session passed in —
  // the home of all cross-build state (dependency registry memoization, plugin
  // disposal bookkeeping). See src/session.js.
  const session = opts.session ?? createSession()
  resetPageMetaCache()

  if (opts.clean) {
    fs.rmSync(path.join(cfg.root, cfg.output), { recursive: true, force: true })
    fs.rmSync(path.join(cfg.root, CACHE_DIR), { recursive: true, force: true })
  }

  // Same plugin set → the cached resources are reused; different set → the
  // previous build's plugins are released before the new ones load.
  const pluginSignature = JSON.stringify(cfg.plugins ?? {})
  if (session.plugin.dispose && pluginSignature !== session.plugin.signature) {
    await session.plugin.dispose()
  }

  const touched = (opts.paths || []).map((p) => relToRoot(p, cfg.root))

  const deps = loadDependencyGraph(cfg.root)
  const { plugin: pluginHost, build: buildHost } = createHosts(cfg, { deps, session })
  const plugins = await loadPlugins(cfg.plugins, pluginHost)
  session.plugin.signature = pluginSignature
  session.plugin.dispose = plugins.dispose

  // Report loaded renderer extensions to the caller (serve's watcher), so a
  // new renderer format is watched without core knowing its extensions.
  for (const renderer of buildHost.renderers) {
    for (const ext of renderer.extensions || []) {
      opts.watchExts?.add(ext)
    }
  }

  const { mode, pages } = await decideMode(cfg, buildHost, { ...opts, deps })

  if (mode === 'noop') {
    console.log('mkadoc: noop')
    return mode
  }

  fs.mkdirSync(path.join(cfg.root, cfg.output), { recursive: true })
  await plugins.contributeChrome({ mode, pages, paths: touched })
  // Nav-owned home: whichever plugin provides `site-root` decides where / goes.
  // Carried on the session (not the config object) — serve reads it after
  // each build; the config stays a pure description of the project.
  session.rootRedirect = () => pluginHost.getService('site-root')?.href ?? null
  writeThemeCss(cfg.root, cfg.output, cfg.sources)
  copyFirstSourceAssets(cfg)

  switch (mode) {
    case 'assets':
      console.log('mkadoc: assets only')
      break
    case 'full':
      console.log('mkadoc: full rebuild')
      await buildPages(
        cfg,
        buildHost,
        listSourcePages(cfg.root, cfg.sources, { rendererForPath: buildHost.rendererForPath }).map(
          (p) => p.page,
        ),
        { concurrency: opts.concurrency, deps },
      )
      await writeSiteIndex(cfg, buildHost)
      pruneStaleHtml(cfg, buildHost.rendererForPath)
      break
    case 'incremental':
      console.log(`mkadoc: incremental ${pages.join(' ')}`)
      await buildPages(cfg, buildHost, pages, { concurrency: opts.concurrency, deps })
      await writeSiteIndex(cfg, buildHost)
      pruneStaleHtml(cfg, buildHost.rendererForPath)
      break
  }

  if (mode !== 'assets') {
    deps.retainPages(
      listSourcePages(cfg.root, cfg.sources, { rendererForPath: buildHost.rendererForPath }).map(
        (p) => p.page,
      ),
    )
    deps.save()
  }

  return mode
}

/**
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('@mkadoc/plugin-host').MkadocBuildHost} host
 * @param {string[]} pages
 * @param {{ concurrency?: number, deps?: import('./deps.js').DependencyGraph | null }} [opts]
 */
async function buildPages(cfg, host, pages, { concurrency, deps } = {}) {
  const limit = concurrency ?? defaultPoolConcurrency(4)
  const outRoot = path.join(cfg.root, cfg.output)
  const chromeBody = host.chromeBody.filter(Boolean).join('\n').trim()
  const headLinks = [...host.headLinks]
  const headScripts = [...host.headScripts]

  await mapPool(pages, limit, async (page) => {
    const renderer = host.rendererForPath(page)
    if (!renderer) {
      throw new Error(`mkadoc: no renderer for ${page}`)
    }
    const source = sourceForRepoPath(cfg.sources, page)
    if (!source) {
      throw new Error(`mkadoc: page not under any source: ${page}`)
    }
    const absPath = path.join(cfg.root, page)
    const baseDir = path.join(cfg.root, source.path)
    const outRel = pageToOutRel(source, page)
    const toFile = path.join(outRoot, outRel)
    fs.mkdirSync(path.dirname(toFile), { recursive: true })
    try {
      const text = fs.readFileSync(absPath, 'utf8')
      const output = await renderer.render({
        sourceText: text,
        absPath,
        baseDir,
      })
      const html = assemblePage({
        title: output.title || '',
        lang: output.lang,
        bodyClass: output.bodyClass,
        body: output.html,
        head: output.head,
        headLinks,
        headScripts,
        chromeBody,
      })
      deps?.setPageIncludes(page, output.includes || [])
      writeIfChanged(toFile, html)
      copyAssets(cfg, output.assets || [])
    } catch (err) {
      const detail = err?.message || String(err)
      throw new Error(`mkadoc: failed to convert ${page}: ${detail}`, { cause: err })
    }
  })
}

/**
 * Copy renderer-reported local assets into the output at mirrored paths.
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {string[]} assets repo-relative file paths
 */
export function copyAssets(cfg, assets) {
  const outRoot = path.join(cfg.root, cfg.output)
  for (const rel of assets) {
    const srcAbs = path.resolve(cfg.root, rel)
    if (srcAbs !== cfg.root && !srcAbs.startsWith(`${cfg.root}${path.sep}`)) {
      console.warn(`mkadoc: referenced asset escapes the project root: ${rel}`)
      continue
    }
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
      console.warn(`mkadoc: referenced asset not found: ${rel}`)
      continue
    }
    copyFileIfChanged(srcAbs, path.join(outRoot, rel))
  }
}

/**
 * Convention: `<first source>/_assets` is always copied to
 * `<output>/<first source.path>/_assets` so chrome-level files (logo override,
 * favicons) are staged and referenceable without any page reference.
 * The `_` prefix keeps it out of page discovery.
 */
function copyFirstSourceAssets(cfg) {
  const first = cfg.sources[0]
  if (!first) return
  const from = path.join(cfg.root, first.path, '_assets')
  if (!fs.existsSync(from)) return
  walkDir(from, {
    shouldEnterDir: (_full, name) => name !== 'node_modules' && name !== '.git',
    onFile: (src) => {
      const rel = relToRoot(src, cfg.root)
      copyFileIfChanged(src, path.join(cfg.root, cfg.output, rel))
    },
  })
}

function pruneStaleHtml(cfg, rendererForPath) {
  const outRoot = path.join(cfg.root, cfg.output)
  const stylesPrefix = path.join(cfg.output, 'styles').split(path.sep).join('/')
  const live = new Set()

  for (const { page, source } of listSourcePages(cfg.root, cfg.sources, { rendererForPath })) {
    live.add(pageToOutRel(source, page))
  }
  // Core-generated site map at the output root.
  live.add('index.html')

  walkDir(outRoot, {
    shouldEnterDir: (full) => {
      const norm = relToRoot(full, cfg.root)
      return norm !== stylesPrefix && !norm.startsWith(`${stylesPrefix}/`)
    },
    onFile: (full, name) => {
      if (!name.endsWith('.html')) return
      const norm = relToRoot(full, cfg.root)
      const rel = norm.slice(`${cfg.output}/`.length)
      if (!live.has(rel)) fs.rmSync(full)
    },
  })
}
