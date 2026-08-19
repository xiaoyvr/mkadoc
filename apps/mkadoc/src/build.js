import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { writeSiteChrome } from './chrome.js'
import { CACHE_DIR } from './config.js'
import { decideMode } from './decide-mode.js'
import { copyFileIfChanged, relToRoot, walkDir, writeIfChanged } from './fs-utils.js'
import { defaultPoolConcurrency, mapPool } from './map-pool.js'
import { createHosts } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'
import {
  isSourceIndexPath,
  listSourcePages,
  pageToOutRel,
  refreshSourceTitles,
  sourceForRepoPath,
} from './sources.js'

export async function build(cfg, opts = {}) {
  if (opts.clean) {
    fs.rmSync(path.join(cfg.root, cfg.output), { recursive: true, force: true })
    fs.rmSync(path.join(cfg.root, CACHE_DIR), { recursive: true, force: true })
  }

  const touched = (opts.paths || []).map((p) => relToRoot(p, cfg.root))
  if (
    opts.forceFull ||
    touched.length === 0 ||
    touched.some((p) => isSourceIndexPath(cfg.sources, p))
  ) {
    await refreshSourceTitles(cfg)
  }

  const { plugin: pluginHost, build: buildHost } = createHosts(cfg)
  const plugins = await loadPlugins(cfg.plugins, pluginHost)
  const { mode, pages } = decideMode(cfg, buildHost, opts)

  fs.mkdirSync(path.join(cfg.root, cfg.output), { recursive: true })
  fs.mkdirSync(path.join(cfg.root, cfg.docinfoDir), { recursive: true })
  await plugins.contributeChrome({ mode, pages, paths: touched })
  await writeSiteChrome(buildHost, { mode, paths: touched })

  if (mode !== 'assets') buildHost.writeHeadDocinfo()
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
        listSourcePages(cfg.root, cfg.sources).map((p) => p.page),
        { concurrency: opts.concurrency },
      )
      pruneStaleHtml(cfg)
      cleanupArtifacts(cfg)
      break
    case 'incremental':
      console.log(`mkadoc: incremental ${pages.join(' ')}`)
      await buildPages(cfg, buildHost, pages, { concurrency: opts.concurrency })
      pruneStaleHtml(cfg)
      break
  }

  return mode
}

async function buildPages(cfg, host, pages, { concurrency } = {}) {
  const attrs = { ...host.attributes }
  if (host.wantsDocinfo()) {
    attrs.docinfodir = path.join(cfg.root, cfg.docinfoDir)
    attrs.docinfo = 'shared'
  }

  const registry = host.registry
  const limit = concurrency ?? defaultPoolConcurrency(4)
  const outRoot = path.join(cfg.root, cfg.output)

  await mapPool(pages, limit, async (page) => {
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
      const doc = await load(text, {
        safe: 'unsafe',
        base_dir: baseDir,
        standalone: true,
        extension_registry: registry,
        attributes: attrs,
        catalog_assets: true,
      })
      const html = String(await doc.convert())
      writeIfChanged(toFile, html)
      copyReferencedAssets(cfg, absPath, doc)
    } catch (err) {
      const detail = err?.message || String(err)
      throw new Error(`mkadoc: failed to convert ${page}: ${detail}`, { cause: err })
    }
  })
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

/** Targets that are not local relative files (URLs, root-absolute, anchors). */
function isExternalOrAbsoluteTarget(target) {
  if (target.startsWith('#') || target.startsWith('/')) return true
  return /^[a-z][a-z0-9+.-]*:/i.test(target)
}

/** Converted pages and AsciiDoc sources are not assets. */
const ASSET_SKIP_RE = /\.(?:html?|adoc|asciidoc)$/i

/**
 * Collect file targets referenced by a converted document: images (block +
 * inline, honoring `:imagesdir:`), `link:` targets, and video/audio blocks.
 * @param {import('@asciidoctor/core').Document} doc
 */
function collectReferencedAssets(doc) {
  const targets = []
  for (const img of doc.getImages?.() || []) {
    const target = String(img.target ?? '').trim()
    const dir = String(img.imagesdir ?? '').trim()
    const relativeDir = dir && !dir.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(dir)
    targets.push(relativeDir ? `${dir}/${target}` : target)
  }
  for (const link of doc.getLinks?.() || []) {
    targets.push(String(link ?? '').trim())
  }
  for (const block of doc.findBy((b) => b.getContext() === 'video' || b.getContext() === 'audio')) {
    targets.push(String(block.getAttribute?.('target') ?? '').trim())
  }
  return targets.filter(Boolean)
}

/**
 * Copy each local relative asset referenced by the page into the output at
 * the mirrored path (output mirrors the source tree, so the emitted relative
 * URL resolves). Absolute/external targets and page/source links are skipped;
 * missing files warn and continue.
 */
function copyReferencedAssets(cfg, pageAbs, doc) {
  const pageDir = path.dirname(pageAbs)
  const outRoot = path.join(cfg.root, cfg.output)
  const seen = new Set()

  for (const target of collectReferencedAssets(doc)) {
    if (isExternalOrAbsoluteTarget(target) || ASSET_SKIP_RE.test(target)) continue
    const srcAbs = path.resolve(pageDir, target)
    const rel = relToRoot(srcAbs, cfg.root)
    if (seen.has(rel)) continue
    seen.add(rel)
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
      console.warn(`mkadoc: referenced asset not found: ${rel}`)
      continue
    }
    copyFileIfChanged(srcAbs, path.join(outRoot, rel))
  }
}

function pruneStaleHtml(cfg) {
  const outRoot = path.join(cfg.root, cfg.output)
  const stylesPrefix = path.join(cfg.output, 'styles').split(path.sep).join('/')
  const live = new Set()

  for (const { page, source } of listSourcePages(cfg.root, cfg.sources)) {
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
