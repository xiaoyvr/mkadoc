import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { convertFile } from '@asciidoctor/core'
import { userError } from './errors.js'
import { copyAssetDirs, relToRoot, walkDir } from './fs-utils.js'
import { createHost } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

const MAX_CONVERT_CONCURRENCY = 4

function defaultConvertConcurrency() {
  const n =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return Math.max(1, Math.min(MAX_CONVERT_CONCURRENCY, n || 1))
}

async function mapPool(items, limit, fn) {
  if (items.length === 0) return
  const workers = Math.min(Math.max(1, limit), items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

function isPage(p, cfg) {
  const src = cfg.source.replace(/\/$/, '')
  if (!p.startsWith(`${src}/`) || !p.endsWith('.adoc')) return false
  if (path.basename(p).startsWith('_')) return false
  return fs.existsSync(path.join(cfg.root, p))
}

function needsAllPages(p, cfg, host) {
  const base = path.basename(p)
  const configRel = relToRoot(cfg.configPath, cfg.root)
  if (p === configRel) return true
  if (base.startsWith('_') && base.endsWith('.adoc')) return true
  return host.classifyPath(p) === 'full'
}

function prepareDirs(cfg) {
  fs.mkdirSync(path.join(cfg.root, cfg.output), { recursive: true })
  fs.mkdirSync(path.join(cfg.root, cfg.docinfoDir), { recursive: true })
}

function assetCopyItems(cfg) {
  const source = cfg.source.replace(/\/$/, '')
  const output = cfg.output.replace(/\/$/, '')
  const implicitFrom = `${source}/styles`
  const implicitTo = `${output}/styles`
  const items = [...(cfg.assets || [])]
  const hasImplicit = items.some((a) => a.from === implicitFrom && a.to === implicitTo)
  if (!hasImplicit) items.push({ from: implicitFrom, to: implicitTo })
  return items
}

function cleanOutput(cfg) {
  fs.rmSync(path.join(cfg.root, cfg.output), { recursive: true, force: true })
  fs.rmSync(path.join(cfg.root, cfg.cache), { recursive: true, force: true })
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

async function convertAdocFile(page, absPath, opts) {
  try {
    await convertFile(absPath, opts)
  } catch (err) {
    const detail = err?.message || String(err)
    throw userError(`mkadoc: failed to convert ${page}: ${detail}`, { cause: err })
  }
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
  const limit = concurrency ?? defaultConvertConcurrency()

  await mapPool(pages, limit, async (page) => {
    await convertAdocFile(page, path.join(cfg.root, page), {
      safe: 'unsafe',
      base_dir: baseDir,
      to_dir: toDir,
      mkdirs: true,
      extension_registry: registry,
      attributes: attrs,
    })
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

function decideMode(cfg, host, { forceFull = false, paths = [] } = {}) {
  if (forceFull || paths.length === 0) {
    return { mode: 'full', pages: [] }
  }

  const pages = []
  let assetsOnly = false
  const changed = paths

  for (const raw of changed) {
    const p = relToRoot(raw, cfg.root)
    if (host.assetPrefixes.some((prefix) => p.startsWith(prefix))) {
      assetsOnly = true
      continue
    }

    const src = cfg.source.replace(/\/$/, '')
    if (p.startsWith(`${src}/styles/`)) {
      assetsOnly = true
      continue
    }
    if (needsAllPages(p, cfg, host)) {
      return { mode: 'full', pages: [] }
    }
    if (isPage(p, cfg)) pages.push(p)
  }
  if (pages.length === 0 && assetsOnly) return { mode: 'assets', pages: [] }
  if (pages.length === 0) return { mode: 'full', pages: [] }
  return { mode: 'incremental', pages }
}

export async function build(cfg, opts = {}) {
  if (opts.clean) cleanOutput(cfg)

  const host = createHost(cfg)
  const plugins = await loadPlugins(cfg.plugins, host)
  const { mode, pages } = decideMode(cfg, host, opts)
  const ctx = { mode, pages }

  prepareDirs(cfg)
  await plugins.contributeChrome(ctx)

  if (mode !== 'assets') host.writeHeadDocinfo()

  copyAssetDirs(cfg.root, assetCopyItems(cfg))

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
