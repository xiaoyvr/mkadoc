import { convertFile } from '@asciidoctor/core'
import fs from 'node:fs'
import path from 'node:path'
import { createHost } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

function relToRoot(p, root) {
  let out = p
  if (path.isAbsolute(out)) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (out.startsWith(prefix)) out = out.slice(prefix.length)
  }
  if (out.startsWith('./')) out = out.slice(2)
  return out.split(path.sep).join('/')
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

function sameFileContent(a, b) {
  if (!fs.existsSync(b)) return false
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

function copyCoreAssets(cfg) {
  for (const item of cfg.assets) {
    const from = path.join(cfg.root, item.from)
    const to = path.join(cfg.root, item.to)
    fs.mkdirSync(to, { recursive: true })
    if (!fs.existsSync(from)) continue
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      const src = path.join(from, ent.name)
      const dest = path.join(to, ent.name)
      if (sameFileContent(src, dest)) continue
      fs.copyFileSync(src, dest)
    }
  }
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
    await convertFile(path.join(cfg.root, page), {
      safe: 'unsafe',
      base_dir: baseDir,
      to_dir: toDir,
      mkdirs: true,
      extension_registry: registry,
      attributes: attrs,
    })
  }
}

function pruneStaleHtml(cfg) {
  const outRoot = path.join(cfg.root, cfg.output)
  const stylesPrefix = path.join(cfg.output, 'styles').split(path.sep).join('/')

  function walk(dir) {
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
  if (fs.existsSync(outRoot)) walk(outRoot)
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
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {{ forceFull?: boolean, paths?: string[] }} opts
 */
export async function build(cfg, opts = {}) {
  const host = createHost(cfg)
  const plugins = await loadPlugins(cfg.plugins, host)
  const { mode, pages } = decideMode(cfg, host, opts)
  const ctx = { mode, pages }

  prepareDirs(cfg)
  await plugins.beforeBuild(ctx)
  await plugins.afterChrome(ctx)

  if (mode !== 'assets') host.writeHeadDocinfo()
  if (mode === 'full' || mode === 'assets') copyCoreAssets(cfg)

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
      break
  }

  return mode
}
