import fs from 'node:fs'
import path from 'node:path'
import { relToRoot } from './fs-utils.js'
import { listSourcePages, sourceForRepoPath } from './sources.js'

function isPage(p, cfg, host) {
  if (path.basename(p).startsWith('_')) return false
  if (!host.rendererForPath(p)) return false
  const source = sourceForRepoPath(cfg.sources, p)
  if (!source) return false
  return fs.existsSync(path.join(cfg.root, p))
}

/** A renderer-owned file under a source (page or partial). */
function isSourceFile(p, cfg, host) {
  if (!host.rendererForPath(p)) return false
  return Boolean(sourceForRepoPath(cfg.sources, p))
}

/**
 * `_theme/*.css` feeds the linked stylesheets (not baked into page HTML).
 * First source only — the site has exactly one theme.css/topbar.css/nav.css
 * output, so only `sources[0]/_theme/` is ever read (theme.js, topbar.js,
 * nav.js). Serve does not watch a non-first source's `_theme` at all.
 */
function isThemeCssPath(cfg, p) {
  const first = cfg.sources[0]
  if (!first) return false
  return p.startsWith(`${first.path}/_theme/`) && p.endsWith('.css')
}

async function needsFullRebuild(p, cfg, host) {
  const configRel = relToRoot(cfg.configPath, cfg.root)
  if (p === configRel) return true
  return (await host.classifyPath(p)) === 'full'
}

/**
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('@mkadoc/plugin-host').MkadocBuildHost} host
 * @param {{ forceFull?: boolean, paths?: string[], deps?: import('./deps.js').DependencyGraph | null }} [opts]
 */
export async function decideMode(cfg, host, { forceFull = false, paths = [], deps = null } = {}) {
  if (forceFull || paths.length === 0) {
    return { mode: 'full', pages: [] }
  }

  const livePages = listSourcePages(cfg.root, cfg.sources, {
    rendererForPath: host.rendererForPath,
  }).map((p) => p.page)

  /** @type {Set<string>} */
  const pages = new Set()
  let assetsOnly = false
  let orphanPartial = false
  const firstSourcePath = cfg.sources[0]?.path

  for (const raw of paths) {
    const p = relToRoot(raw, cfg.root)
    if (host.assetPrefixes.some((prefix) => p.startsWith(prefix))) {
      assetsOnly = true
      continue
    }
    if (await needsFullRebuild(p, cfg, host)) {
      return { mode: 'full', pages: [] }
    }
    // CSS-only theme override — rewrite stylesheet, do not reconvert pages.
    if (isThemeCssPath(cfg, p)) {
      assetsOnly = true
      continue
    }

    // Site-wide (index, logo, _nav, …) or article include → dependent pages.
    const dependents = deps?.pagesDependingOn(p, { livePages }) || []
    if (dependents.length > 0) {
      for (const page of dependents) {
        if (isPage(page, cfg, host)) pages.add(page)
      }
      continue
    }

    if (isPage(p, cfg, host)) {
      pages.add(p)
      continue
    }

    if (firstSourcePath && p.startsWith(`${firstSourcePath}/_assets/`)) {
      assetsOnly = true
      continue
    }

    if (isSourceFile(p, cfg, host)) {
      // No known dependents (unused partial, or cache empty — restart serve to refresh).
      orphanPartial = true
      continue
    }

    // Unknown non-page path (e.g. README.txt) — keep previous safe behavior.
    return { mode: 'full', pages: [] }
  }

  if (pages.size === 0 && assetsOnly) {
    return { mode: 'assets', pages: [] }
  }
  if (pages.size === 0 && orphanPartial) {
    return { mode: 'noop', pages: [] }
  }
  if (pages.size === 0) return { mode: 'full', pages: [] }
  return { mode: 'incremental', pages: [...pages].sort() }
}
