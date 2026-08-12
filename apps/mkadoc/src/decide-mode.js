import fs from 'node:fs'
import path from 'node:path'
import { relToRoot } from './fs-utils.js'

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

export function decideMode(cfg, host, { forceFull = false, paths = [] } = {}) {
  if (forceFull || paths.length === 0) {
    return { mode: 'full', pages: [] }
  }

  const pages = []
  let assetsOnly = false

  for (const raw of paths) {
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
