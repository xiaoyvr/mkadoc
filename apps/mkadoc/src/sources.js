import path from 'node:path'
import { relToRoot, walkDir } from './fs-utils.js'

/**
 * @typedef {object} MkadocSource
 * @property {string} path  repo-relative source dir (posix)
 * @property {string} mount site mount, e.g. `/` or `/apps/mkadoc`
 */

/**
 * Derive the site mount from a source path, verbatim (no magic stripping).
 * `docs` → `/docs`; `apps/mkadoc/docs` → `/apps/mkadoc/docs`
 * @param {string} sourcePath
 */
export function mountFromSourcePath(sourcePath) {
  const norm = sourcePath.replace(/\/$/, '').split('/').filter(Boolean)
  if (norm.length === 0) {
    throw new Error('mkadoc: source path must not be empty')
  }
  return `/${norm.join('/')}`
}

/**
 * @param {string[]} sourcePaths
 * @returns {MkadocSource[]}
 */
export function normalizeSources(sourcePaths) {
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
    sources.push({ path: sourcePath, mount })
  }

  return sources
}

/** @param {string} mount */
export function mountPrefix(mount) {
  return mount === '/' ? '/' : `${mount.replace(/\/$/, '')}/`
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
 * Any renderer extension is normalized to `.html`.
 * `apps/mkadoc/docs/guide.adoc` + mount `/apps/mkadoc/docs` (mounts are the
 * source path verbatim, see `mountFromSourcePath`) → `apps/mkadoc/docs/guide.html`
 * @param {MkadocSource} source
 * @param {string} pageRel repo-relative source path
 */
export function pageToOutRel(source, pageRel) {
  const norm = pageRel.replace(/\\/g, '/')
  const prefix = `${source.path}/`
  if (!norm.startsWith(prefix) && norm !== source.path) {
    throw new Error(`mkadoc: page ${pageRel} is not under source ${source.path}`)
  }
  const under = norm === source.path ? '' : norm.slice(prefix.length)
  const parsed = path.posix.parse(under)
  const htmlUnder = path.posix.join(parsed.dir, `${parsed.name}.html`)
  const mountRel = source.mount.replace(/^\//, '')
  return htmlUnder ? `${mountRel}/${htmlUnder}` : `${mountRel}/index.html`
}

/** @param {MkadocSource} source @param {string} pageRel */
export function pageToHref(source, pageRel) {
  return `/${pageToOutRel(source, pageRel)}`
}

/**
 * @param {string} root
 * @param {MkadocSource[]} sources
 * @param {{ rendererForPath: (p: string) => import('@mkadoc/plugin-host').MkadocRenderer | null }} opts
 * @returns {{ page: string, source: MkadocSource }[]}
 */
export function listSourcePages(root, sources, { rendererForPath }) {
  const pages = []
  for (const source of sources) {
    walkDir(path.join(root, source.path), {
      shouldEnterDir: (_full, name) =>
        name !== 'node_modules' && name !== '.git' && !name.startsWith('_'),
      onFile: (full, name) => {
        if (name.startsWith('_')) return
        const rel = relToRoot(full, root)
        const ok = Boolean(rendererForPath(rel))
        if (ok) pages.push({ page: rel, source })
      },
    })
  }
  return pages
}
