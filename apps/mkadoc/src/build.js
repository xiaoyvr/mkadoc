import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config.js'
import { decideMode } from './decide-mode.js'
import { loadDependencyGraph } from './deps.js'
import { copyFileIfChanged, relToRoot, walkDir, writeIfChanged } from './fs-utils.js'
import { defaultPoolConcurrency, mapPool } from './map-pool.js'
import { assemblePage } from './page.js'
import { createHosts } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'
import {
  extractSourcesMeta,
  listSourcePages,
  pageToOutRel,
  sourceForRepoPath,
  sourceIndexRels,
} from './sources.js'
import { writeThemeCss } from './theme.js'

export async function build(cfg, opts = {}) {
  if (opts.clean) {
    fs.rmSync(path.join(cfg.root, cfg.output), { recursive: true, force: true })
    fs.rmSync(path.join(cfg.root, CACHE_DIR), { recursive: true, force: true })
  }

  const touched = (opts.paths || []).map((p) => relToRoot(p, cfg.root))

  const deps = loadDependencyGraph(cfg.root)
  const { plugin: pluginHost, build: buildHost } = createHosts(cfg, { deps })
  const plugins = await loadPlugins(cfg.plugins, pluginHost)
  const renderers = buildHost.renderers

  const indexRels = sourceIndexRels(cfg, renderers)
  if (opts.forceFull || touched.length === 0 || touched.some((p) => indexRels.has(p))) {
    await extractSourcesMeta(cfg, renderers)
  }

  const { mode, pages } = decideMode(cfg, buildHost, { ...opts, deps })

  if (mode === 'noop') {
    console.log('mkadoc: noop')
    return mode
  }

  fs.mkdirSync(path.join(cfg.root, cfg.output), { recursive: true })
  await plugins.contributeChrome({ mode, pages, paths: touched })
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
      pruneStaleHtml(cfg, buildHost.rendererForPath)
      cleanupArtifacts(cfg)
      break
    case 'incremental':
      console.log(`mkadoc: incremental ${pages.join(' ')}`)
      await buildPages(cfg, buildHost, pages, { concurrency: opts.concurrency, deps })
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
 * @param {import('./plugin/contract.js').MkadocBuildHost} host
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
        attributes: host.attributes,
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
function copyAssets(cfg, assets) {
  const outRoot = path.join(cfg.root, cfg.output)
  for (const rel of assets) {
    const srcAbs = path.join(cfg.root, rel)
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

function cleanupArtifacts(cfg) {
  fs.rmSync(path.join(cfg.root, cfg.output, '.asciidoctor'), {
    recursive: true,
    force: true,
  })
  walkDir(path.join(cfg.root, cfg.output), {
    onFile: (full, name) => {
      if (/^diag-/.test(name) || name.endsWith('.cache')) {
        fs.rmSync(full, { force: true })
      }
    },
  })
}
