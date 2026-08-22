import fs from 'node:fs'
import path from 'node:path'
import { relToRoot } from './fs-utils.js'
import { chromePathForSource, listSourcePages, sourceForRepoPath } from './sources.js'

function isPage(p, cfg) {
  if (!p.endsWith('.adoc') && !p.endsWith('.asciidoc')) return false
  if (path.basename(p).startsWith('_')) return false
  const source = sourceForRepoPath(cfg.sources, p)
  if (!source) return false
  return fs.existsSync(path.join(cfg.root, p))
}

function isSourceAdoc(p, cfg) {
  if (!p.endsWith('.adoc') && !p.endsWith('.asciidoc')) return false
  return Boolean(sourceForRepoPath(cfg.sources, p))
}

/** `_chrome.adoc` feeds `/styles/chrome.css` (linked, not baked into page HTML). */
function isChromeCssPath(sources, p) {
  return sources.some((source) => chromePathForSource(source) === p)
}

function needsFullRebuild(p, cfg, host) {
  const configRel = relToRoot(cfg.configPath, cfg.root)
  if (p === configRel) return true
  return host.classifyPath(p) === 'full'
}

/**
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('./plugin/contract.js').MkadocBuildHost} host
 * @param {{ forceFull?: boolean, paths?: string[], deps?: import('./deps.js').DependencyGraph | null }} [opts]
 */
export function decideMode(cfg, host, { forceFull = false, paths = [], deps = null } = {}) {
  if (forceFull || paths.length === 0) {
    return { mode: 'full', pages: [] }
  }

  const livePages = listSourcePages(cfg.root, cfg.sources).map((p) => p.page)

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
    if (needsFullRebuild(p, cfg, host)) {
      return { mode: 'full', pages: [] }
    }
    // CSS-only chrome override — rewrite stylesheet, do not reconvert pages.
    if (isChromeCssPath(cfg.sources, p)) {
      assetsOnly = true
      continue
    }

    // Site-wide (index, logo, _nav, …) or article include → dependent pages.
    const dependents = deps?.pagesDependingOn(p, { livePages }) || []
    if (dependents.length > 0) {
      for (const page of dependents) {
        if (isPage(page, cfg)) pages.add(page)
      }
      continue
    }

    if (isPage(p, cfg)) {
      pages.add(p)
      continue
    }

    if (firstSourcePath && p.startsWith(`${firstSourcePath}/_assets/`)) {
      assetsOnly = true
      continue
    }

    if (isSourceAdoc(p, cfg)) {
      // No known dependents (unused partial, or cache empty — restart serve to refresh).
      orphanPartial = true
      continue
    }

    // Unknown non-page path (e.g. README.md) — keep previous safe behavior.
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
