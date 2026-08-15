import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { relToRoot, walkDir } from './fs-utils.js'

/**
 * @typedef {object} MkadocSource
 * @property {string} path        repo-relative source dir (posix)
 * @property {string} mount       site mount, e.g. `/` or `/apps/mkadoc`
 * @property {string} title       tab / section label
 */

/**
 * Strip a trailing `docs` segment for mount derivation.
 * `docs` → `/`; `apps/mkadoc/docs` → `/apps/mkadoc`
 * @param {string} sourcePath
 */
export function mountFromSourcePath(sourcePath) {
  const norm = sourcePath.replace(/\/$/, '').split('/').filter(Boolean)
  if (norm.length === 0) {
    throw new Error('mkadoc: source path must not be empty')
  }
  if (norm[norm.length - 1] === 'docs') {
    norm.pop()
  }
  if (norm.length === 0) return '/'
  return `/${norm.join('/')}`
}

function titleFallback(mount) {
  if (mount === '/') return 'Docs'
  const parts = mount.split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Docs'
}

/**
 * Tab title: `{source}/index.adoc` `:tab:`, else doctitle, else last mount segment / Docs.
 * @param {string} root
 * @param {string} sourcePath
 * @param {string} mount
 */
export async function titleForSource(root, sourcePath, mount) {
  const indexAbs = path.join(root, sourcePath, 'index.adoc')
  if (!fs.existsSync(indexAbs)) return titleFallback(mount)

  const text = fs.readFileSync(indexAbs, 'utf8')
  const doc = await load(text, { safe: 'unsafe', standalone: false })
  const tab = String(doc.getAttribute?.('tab') || '').trim()
  if (tab) return tab
  const title = String(doc.getDoctitle?.() || doc.getAttribute?.('doctitle') || '').trim()
  return title || titleFallback(mount)
}

/**
 * @param {string[]} sourcePaths
 * @param {string} root
 * @returns {Promise<MkadocSource[]>}
 */
export async function normalizeSources(sourcePaths, root) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('mkadoc: sources must be a non-empty array of paths')
  }

  /** @type {MkadocSource[]} */
  const sources = []
  const mounts = new Set()

  for (const raw of sourcePaths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('mkadoc: each source must be a non-empty path string')
    }
    const sourcePath = raw.replace(/\\/g, '/').replace(/\/$/, '')
    if (sourcePath.includes('..') || path.isAbsolute(sourcePath)) {
      throw new Error(`mkadoc: invalid source path: ${JSON.stringify(raw)}`)
    }
    const mount = mountFromSourcePath(sourcePath)
    if (mounts.has(mount)) {
      throw new Error(`mkadoc: duplicate source mount ${mount} (from ${sourcePath})`)
    }
    mounts.add(mount)
    const title = await titleForSource(root, sourcePath, mount)
    sources.push({ path: sourcePath, mount, title })
  }

  return sources
}

/** @param {string} mount */
export function mountPrefix(mount) {
  return mount === '/' ? '/' : `${mount.replace(/\/$/, '')}/`
}

/**
 * Longest matching source for a site pathname (`/apps/mkadoc/guide.html`).
 * @param {MkadocSource[]} sources
 * @param {string} pathname
 */
export function sourceForPathname(sources, pathname) {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || '/'
  let best = null
  let bestLen = -1
  for (const src of sources) {
    if (src.mount === '/') {
      if (bestLen < 0) {
        best = src
        bestLen = 0
      }
      continue
    }
    const prefix = mountPrefix(src.mount)
    if (pathOnly === src.mount || pathOnly.startsWith(prefix)) {
      if (src.mount.length > bestLen) {
        best = src
        bestLen = src.mount.length
      }
    }
  }
  return best
}

/**
 * Find source that owns a repo-relative file path (`apps/mkadoc/docs/guide.adoc`).
 * @param {MkadocSource[]} sources
 * @param {string} relPath
 */
export function sourceForRepoPath(sources, relPath) {
  const norm = relPath.replace(/\\/g, '/')
  let best = null
  let bestLen = -1
  for (const src of sources) {
    const prefix = `${src.path}/`
    if (norm === src.path || norm.startsWith(prefix)) {
      if (src.path.length > bestLen) {
        best = src
        bestLen = src.path.length
      }
    }
  }
  return best
}

/**
 * Repo-relative page path → output href path (no leading site/, with .html).
 * `apps/mkadoc/docs/guide.adoc` + mount `/apps/mkadoc` → `apps/mkadoc/guide.html`
 * @param {import('./sources.js').MkadocSource} source
 * @param {string} pageRel repo-relative .adoc path
 */
export function pageToOutRel(source, pageRel) {
  const norm = pageRel.replace(/\\/g, '/')
  const prefix = `${source.path}/`
  if (!norm.startsWith(prefix) && norm !== source.path) {
    throw new Error(`mkadoc: page ${pageRel} is not under source ${source.path}`)
  }
  const under = norm === source.path ? '' : norm.slice(prefix.length)
  const htmlUnder = under.replace(/\.adoc$/, '.html')
  if (source.mount === '/') return htmlUnder
  const mountRel = source.mount.replace(/^\//, '')
  return htmlUnder ? `${mountRel}/${htmlUnder}` : `${mountRel}/index.html`
}

/** @param {import('./sources.js').MkadocSource} source @param {string} pageRel */
export function pageToHref(source, pageRel) {
  return `/${pageToOutRel(source, pageRel)}`
}

/**
 * @param {string} root
 * @param {import('./sources.js').MkadocSource[]} sources
 * @returns {{ page: string, source: import('./sources.js').MkadocSource }[]}
 */
export function listSourcePages(root, sources) {
  const pages = []
  for (const source of sources) {
    walkDir(path.join(root, source.path), {
      shouldEnterDir: (_full, name) => name !== 'node_modules' && name !== '.git',
      onFile: (full, name) => {
        if (name.endsWith('.adoc') && !name.startsWith('_')) {
          pages.push({ page: relToRoot(full, root), source })
        }
      },
    })
  }
  return pages
}

/** Convention: `{source}/index.adoc` owns the tab title. */
export function isSourceIndexPath(sources, relPath) {
  const norm = relPath.replace(/\\/g, '/')
  return sources.some((source) => norm === `${source.path}/index.adoc`)
}

/**
 * Re-read tab titles from each source's index.adoc into `cfg.sources` (in place).
 * @param {import('./config.js').MkadocConfig} cfg
 */
export async function refreshSourceTitles(cfg) {
  for (const source of cfg.sources) {
    source.title = await titleForSource(cfg.root, source.path, source.mount)
  }
}

/** Convention: `{source}/_nav.adoc` */
export function navPathForSource(source) {
  return `${source.path}/_nav.adoc`
}

/** Convention: `{source}/_chrome.adoc` (first source may override site chrome CSS) */
export function chromePathForSource(source) {
  return `${source.path}/_chrome.adoc`
}
