import fs from 'node:fs'
import path from 'node:path'
import { relToRoot, walkDir } from './fs-utils.js'

/**
 * @typedef {object} MkadocSource
 * @property {string} path        repo-relative source dir (posix)
 * @property {string} mount       site mount, e.g. `/` or `/apps/mkadoc`
 * @property {string} title       source bar / section label
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

function titleFallback(mount) {
  const parts = mount.split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Docs'
}

/**
 * Find `<sourcePath>/<basename><ext>` among the loaded renderers' extensions.
 * Registration order decides precedence when multiple renderers match.
 * @param {string} root
 * @param {string} sourcePath
 * @param {string} basename e.g. `index` or `_nav`
 * @param {import('./plugin/contract.js').MkadocRenderer[]} renderers
 * @returns {{ path: string, rel: string, renderer: import('./plugin/contract.js').MkadocRenderer, ext: string } | null}
 */
export function findSourceFile(root, sourcePath, basename, renderers) {
  const dir = path.join(root, sourcePath)
  for (const renderer of renderers) {
    for (const ext of renderer.extensions || []) {
      const abs = path.join(dir, `${basename}${ext}`)
      if (fs.existsSync(abs)) {
        return { path: abs, rel: `${sourcePath}/${basename}${ext}`, renderer, ext }
      }
    }
  }
  return null
}

/**
 * Read `{source}/index.<ext>` metadata used for the source bar.
 * Source-bar label: `:nav_label:` / frontmatter `nav_label`, else doctitle, else mount fallback.
 * @param {string} root
 * @param {string} sourcePath
 * @param {string} mount
 * @param {import('./plugin/contract.js').MkadocRenderer[]} renderers
 * @returns {Promise<{ title: string }>}
 */
export async function sourceMetaForIndex(root, sourcePath, mount, renderers) {
  const found = findSourceFile(root, sourcePath, 'index', renderers)
  if (!found) return { title: titleFallback(mount) }

  const text = fs.readFileSync(found.path, 'utf8')
  const meta = await found.renderer.extractMeta(text, found.path)
  const title = String(meta.navLabel || meta.title || '').trim() || titleFallback(mount)
  return { title }
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
    // Label is filled later by extractSourcesMeta (needs renderers loaded).
    sources.push({ path: sourcePath, mount, title: titleFallback(mount) })
  }

  return sources
}

/**
 * Fill source-bar labels from each source's index file via its renderer.
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('./plugin/contract.js').MkadocRenderer[]} renderers
 */
export async function extractSourcesMeta(cfg, renderers) {
  for (const source of cfg.sources) {
    const meta = await sourceMetaForIndex(cfg.root, source.path, source.mount, renderers)
    source.title = meta.title
  }
}

/** @param {string} mount */
export function mountPrefix(mount) {
  return mount === '/' ? '/' : `${mount.replace(/\/$/, '')}/`
}

/**
 * Convention: a request for the site root redirects to the first source's index
 * page, unless the first source already mounts at `/` (root is served directly).
 * @param {MkadocSource[]} sources
 * @returns {string|null} redirect target href, or null when no redirect is needed
 */
export function rootRedirectHref(sources) {
  const first = sources[0]
  if (!first || first.mount === '/') return null
  return `${first.mount}/index.html`
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
 * Any renderer extension is normalized to `.html`.
 * `apps/mkadoc/docs/guide.adoc` + mount `/apps/mkadoc` → `apps/mkadoc/guide.html`
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
 * @param {{ rendererForPath: (p: string) => import('./plugin/contract.js').MkadocRenderer | null }} opts
 * @returns {{ page: string, source: MkadocSource }[]}
 */
export function listSourcePages(root, sources, { rendererForPath } = {}) {
  const pages = []
  for (const source of sources) {
    walkDir(path.join(root, source.path), {
      shouldEnterDir: (_full, name) =>
        name !== 'node_modules' && name !== '.git' && !name.startsWith('_'),
      onFile: (full, name) => {
        if (name.startsWith('_')) return
        const rel = relToRoot(full, root)
        const ok = rendererForPath
          ? Boolean(rendererForPath(rel))
          : /\.(?:adoc|asciidoc)$/.test(name)
        if (ok) pages.push({ page: rel, source })
      },
    })
  }
  return pages
}

/**
 * Repo-relative paths of every source's index file (any renderer extension).
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('./plugin/contract.js').MkadocRenderer[]} renderers
 */
export function sourceIndexRels(cfg, renderers) {
  const rels = new Set()
  for (const source of cfg.sources) {
    const found = findSourceFile(cfg.root, source.path, 'index', renderers)
    if (found) rels.add(found.rel)
  }
  return rels
}
