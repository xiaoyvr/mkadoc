import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { formatConfigZodError } from '../../config-schema.js'
import { relToRoot } from '../../fs-utils.js'
import { pageMeta } from '../../meta-cache.js'
import { mountPrefix, pageToHref } from '../../sources.js'

/**
 * Nav data model: the convention-based auto-nav tree, `_nav.yaml`
 * parsing/validation, and source-entry resolution. Pure — no session state,
 * no rendering (see `html.js`), no chrome orchestration (see `nav.js`).
 */

/**
 * One declarative nav entry.
 * - `page` + optional `label` (fallback; the page's own title wins)
 * - `href` + required `label`
 * - `children` section; `label` required when there is no `page`
 */
const NavItemSchema = z
  .object({
    label: z.string().min(1).optional(),
    page: z.string().min(1).optional(),
    href: z.string().min(1).optional(),
    children: z.array(z.lazy(() => NavItemSchema)).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const hasPage = Boolean(item.page)
    const hasHref = Boolean(item.href)
    const hasChildren = Boolean(item.children?.length)
    if (!hasPage && !hasHref && !hasChildren) {
      ctx.addIssue({
        code: 'custom',
        message: 'each nav item needs one of "page", "href", or "children"',
      })
    }
    if (hasPage && hasHref) {
      ctx.addIssue({
        code: 'custom',
        message: 'an item cannot have both "page" and "href"',
        path: ['href'],
      })
    }
    if (!hasPage && !item.label) {
      ctx.addIssue({
        code: 'custom',
        message: '"label" is required when there is no "page"',
        path: ['label'],
      })
    }
  })

const NavFileSchema = z.array(NavItemSchema).min(1)

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function isPageFile(host, name) {
  const ext = path.extname(name).toLowerCase()
  return host.renderers.some((r) => r.extensions?.includes(ext))
}

/** Find a directory's own page (`index.<ext>`, any renderer extension). */
function findIndexInDir(host, dirAbs) {
  for (const renderer of host.renderers) {
    for (const ext of renderer.extensions || []) {
      const abs = path.join(dirAbs, `index${ext}`)
      if (fs.existsSync(abs)) return { abs, renderer }
    }
  }
  return null
}

/**
 * Build the convention-based auto-nav node for a directory.
 * node = `{ label, href, rel, children }`; `href`/`rel` are null when the
 * folder has no index page (a non-clickable section).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 * @param {string} dirRel repo-relative directory
 */
export async function buildFolder(host, source, dirRel) {
  const dirAbs = path.join(host.root, dirRel)
  const dirName = path.basename(dirRel)

  const index = findIndexInDir(host, dirAbs)
  let label = dirName
  let href = null
  let rel = null
  if (index) {
    rel = relToRoot(index.abs, host.root)
    label = (await metaLabelFor(index.abs, index.renderer)) || dirName
    href = pageToHref(source, rel)
  }

  const children = []
  const entries = fs
    .readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.'))
    .sort((a, b) => naturalCompare(a.name, b.name))
  for (const e of entries) {
    if (e.isDirectory()) {
      const node = await buildFolder(host, source, path.posix.join(dirRel, e.name))
      if (node.href || node.children.length) children.push(node)
    } else if (e.isFile()) {
      if (path.parse(e.name).name === 'index') continue
      if (!isPageFile(host, e.name)) continue
      const abs = path.join(dirAbs, e.name)
      const pageRel = relToRoot(abs, host.root)
      const renderer = host.renderers.find((r) =>
        r.extensions?.includes(path.extname(e.name).toLowerCase()),
      )
      const pageLabel =
        (await metaLabelFor(abs, renderer)) || path.basename(e.name, path.extname(e.name))
      children.push({
        label: pageLabel,
        href: pageToHref(source, pageRel),
        rel: pageRel,
        children: [],
      })
    }
  }

  return { label, href, rel, children }
}

/** Resolve a `page:` entry to the mounted `.html` href (extension stripped). */
export function navPageHref(source, page) {
  const p = String(page)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.[^./]+$/, '')
  const mount = source.mount.replace(/\/$/, '')
  return `${mount}/${p}.html`
}

/** Normalize a `page:` value to `dir/basename` (no extension, no leading slash). */
export function normalizePage(page) {
  return String(page)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.[^./]+$/, '')
}

/**
 * Find the page file a `page:` entry refers to (any renderer extension).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 * @param {string} page
 * @returns {{ abs: string, renderer: import('@mkadoc/plugin-host').MkadocRenderer } | null}
 */
export function findPageFile(host, source, page) {
  const p = normalizePage(page)
  const base = path.basename(p)
  const baseDir = path.join(host.root, source.path, path.dirname(p))
  for (const renderer of host.renderers) {
    for (const ext of renderer.extensions || []) {
      const abs = path.join(baseDir, `${base}${ext}`)
      if (fs.existsSync(abs)) return { abs, renderer }
    }
  }
  return null
}

/**
 * Read a page's metadata label (`:nav_label:` → title), or '' when absent.
 * @param {string} absPath
 * @param {import('@mkadoc/plugin-host').MkadocRenderer} renderer
 */
export async function metaLabelFor(absPath, renderer) {
  const meta = await pageMeta(absPath, renderer)
  return String(meta.navLabel || meta.title || '').trim()
}

/**
 * Derive a `page:` entry's label from the page's own nav label/title.
 * Returns '' when the page has no label (caller falls back to `label`/basename).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 * @param {string} page
 */
export async function derivePageLabel(host, source, page) {
  const found = findPageFile(host, source, page)
  if (!found) return ''
  return metaLabelFor(found.abs, found.renderer)
}

/**
 * Resolve a repo-relative page path's nav label (used by the classifier).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {string} relPath
 */
export async function pageLabelForRel(host, relPath) {
  const abs = path.join(host.root, relPath)
  if (!fs.existsSync(abs)) return ''
  const renderer = host.renderers.find((r) =>
    r.extensions?.includes(path.extname(relPath).toLowerCase()),
  )
  if (!renderer) return ''
  return metaLabelFor(abs, renderer)
}

/** First leaf href in a `_nav.yaml` item tree (depth-first). */
function firstLeafHref(items, source) {
  for (const item of items) {
    if (item.page) return navPageHref(source, item.page)
    if (item.href) return item.href
    if (item.children?.length) {
      const href = firstLeafHref(item.children, source)
      if (href) return href
    }
  }
  return null
}

/** Flatten a `_nav.yaml` item tree into its `page:` entries. */
export function flattenPageItems(items, out = []) {
  for (const item of items) {
    if (item.page) out.push(item)
    if (item.children?.length) flattenPageItems(item.children, out)
  }
  return out
}

/**
 * Resolve a `_nav.yaml` item to its `{ title, href }` entry.
 * @param {object} item
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 */
async function resolveYamlItemEntry(item, host, source) {
  if (item.page) {
    const href = navPageHref(source, item.page)
    const derived = await derivePageLabel(host, source, item.page)
    const title = derived || item.label || path.basename(normalizePage(item.page))
    return { title, href }
  }
  if (item.children?.length) {
    return { title: item.label || '', href: firstLeafHref(item.children, source) }
  }
  return { title: item.label || '', href: item.href ?? null }
}

/**
 * Resolve a source's entry point (first nav item) → `{ title, href }`.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 */
export async function resolveSourceEntry(host, source) {
  const adocRenderer = host.renderers.find((r) => r.extensions?.includes('.adoc'))

  const adocPath = path.join(host.root, source.path, '_nav.adoc')
  if (adocRenderer && fs.existsSync(adocPath)) {
    const text = fs.readFileSync(adocPath, 'utf8')
    const link = await adocRenderer.extractFirstLink?.({
      sourceText: text,
      absPath: adocPath,
      baseDir: path.join(host.root, source.path),
      linkPrefix: mountPrefix(source.mount),
    })
    if (link) return { title: link.label, href: link.href }
  }

  const items = readNavYaml(host, source)
  if (items?.length) {
    return resolveYamlItemEntry(items[0], host, source)
  }

  const root = await buildFolder(host, source, source.path)
  return { title: root.label, href: root.href }
}

/**
 * Read + validate `<source>/_nav.yaml`, or return null when absent.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 */
export function readNavYaml(host, source) {
  const abs = path.join(host.root, source.path, '_nav.yaml')
  if (!fs.existsSync(abs)) return null
  const text = fs.readFileSync(abs, 'utf8')
  let raw
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new Error(`mkadoc:nav: invalid _nav.yaml (${source.path}): ${err?.message || err}`)
  }
  const result = NavFileSchema.safeParse(raw ?? [])
  if (!result.success) {
    throw new Error(
      `mkadoc:nav: invalid _nav.yaml (${source.path}): ${formatConfigZodError(result.error)}`,
    )
  }
  return result.data
}
