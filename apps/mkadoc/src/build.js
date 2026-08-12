import fs from 'node:fs'
import path from 'node:path'
import { convertFile } from '@asciidoctor/core'
import { decideMode } from './decide-mode.js'
import { copyAssetDirs, relToRoot, walkDir } from './fs-utils.js'
import { defaultPoolConcurrency, mapPool } from './map-pool.js'
import { createHost } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

export async function build(cfg, opts = {}) {
  if (opts.clean) {
    fs.rmSync(path.join(cfg.root, cfg.output), { recursive: true, force: true })
    fs.rmSync(path.join(cfg.root, cfg.cache), { recursive: true, force: true })
  }

  const host = createHost(cfg)
  const plugins = await loadPlugins(cfg.plugins, host)
  const { mode, pages } = decideMode(cfg, host, opts)

  fs.mkdirSync(path.join(cfg.root, cfg.output), { recursive: true })
  fs.mkdirSync(path.join(cfg.root, cfg.docinfoDir), { recursive: true })
  await plugins.contributeChrome({ mode, pages })

  if (mode !== 'assets') host.writeHeadDocinfo()

  const source = cfg.source.replace(/\/$/, '')
  const output = cfg.output.replace(/\/$/, '')
  const implicitFrom = `${source}/styles`
  const implicitTo = `${output}/styles`
  const assetItems = [...(cfg.assets || [])]
  if (!assetItems.some((a) => a.from === implicitFrom && a.to === implicitTo)) {
    assetItems.push({ from: implicitFrom, to: implicitTo })
  }
  copyAssetDirs(cfg.root, assetItems)

  switch (mode) {
    case 'assets':
      console.log('mkadoc: assets only')
      break
    case 'full':
      console.log('mkadoc: full rebuild')
      await buildPages(cfg, host, listPages(cfg), { concurrency: opts.concurrency })
      pruneStaleHtml(cfg)
      cleanupArtifacts(cfg)
      break
    case 'incremental':
      console.log(`mkadoc: incremental ${pages.join(' ')}`)
      await buildPages(cfg, host, pages, { concurrency: opts.concurrency })
      pruneStaleHtml(cfg)
      break
  }

  return mode
}

function listPages(cfg) {
  const pages = []
  walkDir(path.join(cfg.root, cfg.source), {
    shouldEnterDir: (_full, name) => name !== 'node_modules' && name !== '.git',
    onFile: (full, name) => {
      if (name.endsWith('.adoc') && !name.startsWith('_')) {
        pages.push(relToRoot(full, cfg.root))
      }
    },
  })
  return pages
}

async function buildPages(cfg, host, pages, { concurrency } = {}) {
  const attrs = { ...host.attributes }
  if (host.wantsDocinfo()) {
    attrs.docinfodir = path.join(cfg.root, cfg.docinfoDir)
    attrs.docinfo = 'shared'
  }

  const baseDir = path.join(cfg.root, cfg.source)
  const toDir = path.join(cfg.root, cfg.output)
  const registry = host.registry
  const limit = concurrency ?? defaultPoolConcurrency(4)

  await mapPool(pages, limit, async (page) => {
    const absPath = path.join(cfg.root, page)
    try {
      await convertFile(absPath, {
        safe: 'unsafe',
        base_dir: baseDir,
        to_dir: toDir,
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

  walkDir(outRoot, {
    shouldEnterDir: (full) => {
      const norm = relToRoot(full, cfg.root)
      return norm !== stylesPrefix && !norm.startsWith(`${stylesPrefix}/`)
    },
    onFile: (full, name) => {
      if (!name.endsWith('.html')) return
      const norm = relToRoot(full, cfg.root)
      const rel = norm.slice(`${cfg.output}/`.length)
      const adoc = path.join(cfg.source, rel.replace(/\.html$/, '.adoc'))
      if (!fs.existsSync(path.join(cfg.root, adoc))) fs.rmSync(full)
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
