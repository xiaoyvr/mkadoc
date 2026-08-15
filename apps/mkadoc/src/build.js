import fs from 'node:fs'
import path from 'node:path'
import { convertFile } from '@asciidoctor/core'
import { writeSiteChrome } from './chrome.js'
import { CACHE_DIR } from './config.js'
import { decideMode } from './decide-mode.js'
import { copyAssetDirs, relToRoot, walkDir } from './fs-utils.js'
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

  const output = cfg.output.replace(/\/$/, '')
  const assetItems = [...(cfg.assets || [])]
  const stylesSource = cfg.sources.find((s) => fs.existsSync(path.join(cfg.root, s.path, 'styles')))
  if (stylesSource) {
    const implicitFrom = `${stylesSource.path}/styles`
    const implicitTo = `${output}/styles`
    if (!assetItems.some((a) => a.from === implicitFrom && a.to === implicitTo)) {
      assetItems.push({ from: implicitFrom, to: implicitTo })
    }
  }
  copyAssetDirs(cfg.root, assetItems)

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
      await convertFile(absPath, {
        safe: 'unsafe',
        base_dir: baseDir,
        to_dir: path.dirname(toFile),
        to_file: path.basename(toFile),
        mkdirs: true,
        extension_registry: registry,
        attributes: attrs,
      })
    } catch (err) {
      const detail = err?.message || String(err)
      throw new Error(`mkadoc: failed to convert ${page}: ${detail}`, { cause: err })
    }
  })
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
