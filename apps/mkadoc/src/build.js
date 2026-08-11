import fs from 'node:fs'
import path from 'node:path'
import { convertFile } from '@asciidoctor/core'
import { copyAssetDirs, relToRoot } from './fs-utils.js'
import { createHost } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

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

/**
 * Asset dirs to copy: configured `assets` plus implicit `<source>/styles` → `<output>/styles`.
 * @param {{ source: string, output: string, assets?: { from: string, to: string }[] }} cfg
 * @returns {{ from: string, to: string }[]}
 */
export function assetCopyItems(cfg) {
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
  const srcRoot = path.join(cfg.root, cfg.source)
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile() && ent.name.endsWith('.adoc') && !ent.name.startsWith('_')) {
        pages.push(relToRoot(full, cfg.root))
      }
    }
  }
  if (fs.existsSync(srcRoot)) walk(srcRoot)
  return pages
}

/**
 * Convert one AsciiDoc page; rethrow with the page path in the message.
 * @param {string} page root-relative page path (for errors)
 * @param {string} absPath
 * @param {object} opts asciidoctor convertFile options
 */
export async function convertAdocFile(page, absPath, opts) {
  try {
    await convertFile(absPath, opts)
  } catch (err) {
    const detail = err?.message || String(err)
    const wrapped = new Error(`mkadoc: failed to convert ${page}: ${detail}`)
    wrapped.cause = err
    throw wrapped
  }
}

async function buildPages(cfg, host, pages) {
  const attrs = { ...host.attributes }
  if (host.wantsDocinfo()) {
    attrs.docinfodir = path.join(cfg.root, cfg.docinfoDir)
    attrs.docinfo = 'shared'
  }

  const baseDir = path.join(cfg.root, cfg.source)
  const toDir = path.join(cfg.root, cfg.output)
  const registry = host.registry

  for (const page of pages) {
    await convertAdocFile(page, path.join(cfg.root, page), {
      safe: 'unsafe',
      base_dir: baseDir,
      to_dir: toDir,
      mkdirs: true,
      extension_registry: registry,
      attributes: attrs,
    })
  }
}

/**
 * Remove HTML whose source `.adoc` no longer exists.
 * Skips `output/styles/` (generated/copied assets).
 * @param {object} cfg
 */
export function pruneStaleHtml(cfg) {
  const outRoot = path.join(cfg.root, cfg.output)
  const stylesPrefix = path.join(cfg.output, 'styles').split(path.sep).join('/')

  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      const norm = relToRoot(full, cfg.root)
      if (ent.isDirectory()) {
        if (norm === stylesPrefix || norm.startsWith(`${stylesPrefix}/`)) continue
        walk(full)
      } else if (ent.isFile() && ent.name.endsWith('.html')) {
        const rel = norm.slice(`${cfg.output}/`.length)
        const adoc = path.join(cfg.source, rel.replace(/\.html$/, '.adoc'))
        if (!fs.existsSync(path.join(cfg.root, adoc))) fs.rmSync(full)
      }
    }
  }
  walk(outRoot)
}

function cleanupArtifacts(cfg) {
  fs.rmSync(path.join(cfg.root, cfg.output, '.asciidoctor'), {
    recursive: true,
    force: true,
  })
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (/^diag-/.test(ent.name) || ent.name.endsWith('.cache')) {
        fs.rmSync(full, { force: true })
      }
    }
  }
  walk(path.join(cfg.root, cfg.output))
}

/**
 * Decide rebuild mode from changed paths.
 * @param {object} cfg
 * @param {{ assetPrefixes: string[], classifyPath: (p: string) => 'full' | null }} host
 * @param {{ forceFull?: boolean, paths?: string[] }} [opts]
 * @returns {{ mode: 'full' | 'incremental' | 'assets', pages: string[] }}
 */
export function decideMode(cfg, host, { forceFull = false, paths = [] } = {}) {
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
    // Core generic assets: <source>/styles/
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

/**
 * @param {Awaited<ReturnType<import('./config.js').loadConfig>>} cfg
 * @param {{ forceFull?: boolean, paths?: string[], clean?: boolean }} opts
 */
export async function build(cfg, opts = {}) {
  if (opts.clean) cleanOutput(cfg)

  const host = createHost(cfg)
  const plugins = await loadPlugins(cfg.plugins, host)
  const { mode, pages } = decideMode(cfg, host, opts)
  const ctx = { mode, pages }

  prepareDirs(cfg)
  await plugins.contributeChrome(ctx)

  if (mode !== 'assets') host.writeHeadDocinfo()
  // Always copy: incremental may batch page + asset edits, and sameFileContent
  // skips unchanged files. Includes implicit <source>/styles → <output>/styles.
  copyAssetDirs(cfg.root, assetCopyItems(cfg))

  switch (mode) {
    case 'assets':
      console.log('mkadoc: assets only')
      break
    case 'full':
      console.log('mkadoc: full rebuild')
      await buildPages(cfg, host, listPages(cfg))
      pruneStaleHtml(cfg)
      cleanupArtifacts(cfg)
      break
    case 'incremental':
      console.log(`mkadoc: incremental ${pages.join(' ')}`)
      await buildPages(cfg, host, pages)
      // Also prune: a delete batched with page edits is incremental, and would
      // otherwise leave orphan HTML for the removed sources.
      pruneStaleHtml(cfg)
      break
  }

  return mode
}
