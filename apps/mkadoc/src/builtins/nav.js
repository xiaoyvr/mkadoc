import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { formatConfigZodError } from '../config-schema.js'
import { relToRoot, resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtml, escapeHtmlAttr } from '../html-utils.js'
import { pageMeta } from '../meta-cache.js'
import { parsePluginOptions } from '../plugin/options.js'
import { mountPrefix, pageToHref } from '../sources.js'
import { readThemeOverride, themeDirForSource } from '../theme.js'

const OptionsSchema = z.object({}).strict()

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

// ---------------------------------------------------------------------------
// Nav-model state (session-scoped) — used by the async classifier to detect
// `:nav_label:`/title changes on nav-referenced pages without forcing a full
// rebuild on content-only edits. It is session state that must outlive the
// per-build plugin instances (the classifier compares against the previous
// build's labels), so it lives in the session (host.session.nav) rather than
// module scope: warmed by each chrome pass, read by the next rebuild's
// classifier. Safe today because the CLI `build` is always forceFull, so this
// classifier is only consulted under `serve`, where the caches are warmed by
// the initial build's chrome pass. A fresh session has no history — if a
// non-forceFull CLI path is ever added, this needs revisiting.
// ---------------------------------------------------------------------------

/** Session-scoped nav classifier state (see src/session.js). */
function navState(host) {
  return host.session.nav
}
const CSS_HREF = '/styles/nav.css'
const JS_HREF = '/styles/nav.js'

/**
 * Level-1 source bar: one link per top-level source (`data-mount`), rendered
 * as a bar under the topbar. Core theme.css loads after this asset in the
 * head, so `_theme/theme.css` overrides still win the cascade.
 */
const SOURCES_CSS = `/* mkadoc:nav — level-1 source bar */
:root {
  --mkadoc-sources-height: 2.5rem;
}

.mkadoc-sources {
  margin-left: calc(-1 * var(--mkadoc-articles-width, 0px));
  display: flex;
  align-items: stretch;
  height: 2.5rem;
  gap: 0.25rem;
  padding: 0 1.25rem;
  background: #fff;
  border-bottom: 1px solid #e0e0dc;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.mkadoc-sources::-webkit-scrollbar {
  display: none;
}

.mkadoc-source {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 100%;
  font-family: "Open Sans", "DejaVu Sans", sans-serif;
  font-size: 0.9rem;
  color: rgba(0, 0, 0, 0.6);
  text-decoration: none;
  padding: 0 0.85rem;
  border-bottom: 2px solid transparent;
}

.mkadoc-source:hover,
.mkadoc-source:focus {
  color: #2156a5;
}

.mkadoc-source.is-active {
  color: #ba3925;
  font-weight: 600;
  border-bottom-color: #ba3925;
}

@media screen and (max-width: 767px) {
  .mkadoc-sources {
    margin-left: 0;
    padding-left: 1rem;
    padding-right: 1rem;
  }
}
`

const DEFAULT_NAV_CSS = fs
  .readFileSync(fileURLToPath(new URL('./nav-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Site navigation runtime (one asset): mark the current article, drive the
 * fixed article sidebar's scroll offset, and activate the active source + its
 * article list. Self-contained — derives the active mount from the URL the
 * same way core used to (longest `data-mount` matching the path).
 */
const NAV_JS = fs
  .readFileSync(fileURLToPath(new URL('./nav-client.js', import.meta.url)), 'utf8')
  .trim()

export { NAV_JS }

/** Level-1 bar: one entry per source (clickable only when it has a href). */
function sourcesBarHtml(entries) {
  return entries
    .map(({ source, title, href }) => {
      const mountAttr = `data-mount="${escapeHtmlAttr(source.mount)}"`
      const label = escapeHtml(title)
      return href
        ? `<a class="mkadoc-source" ${mountAttr} href="${escapeHtmlAttr(href)}">${label}</a>`
        : `<span class="mkadoc-source" ${mountAttr}>${label}</span>`
    })
    .join('\n')
}

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
 * @param {import('../sources.js').MkadocSource} source
 * @param {string} dirRel repo-relative directory
 */
async function buildFolder(host, source, dirRel) {
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

function renderAutoNavNode(node) {
  const linkHtml = node.href
    ? `<a href="${escapeHtmlAttr(node.href)}">${escapeHtml(node.label)}</a>`
    : escapeHtml(node.label)
  const headHtml = `<p>${linkHtml}</p>`
  if (node.children.length) {
    return `<li>${headHtml}\n<ul>\n${node.children.map(renderAutoNavNode).join('\n')}\n</ul></li>`
  }
  return `<li>${headHtml}</li>`
}

/** Convention-based sidebar: the source's own page first, then its tree. */
async function autoNavHtml(host, source) {
  const root = await buildFolder(host, source, source.path)
  const items = []
  if (root.href) {
    items.push(
      `<li><p><a href="${escapeHtmlAttr(root.href)}">${escapeHtml(root.label)}</a></p></li>`,
    )
  }
  items.push(...root.children.map(renderAutoNavNode))
  if (items.length === 0) {
    return '<div class="paragraph"><p><em>No pages</em></p></div>\n'
  }
  return `<div class="ulist"><ul>\n${items.join('\n')}\n</ul></div>\n`
}

/** Resolve a `page:` entry to the mounted `.html` href (extension stripped). */
function navPageHref(source, page) {
  const p = String(page)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.[^./]+$/, '')
  const mount = source.mount.replace(/\/$/, '')
  return `${mount}/${p}.html`
}

/** Normalize a `page:` value to `dir/basename` (no extension, no leading slash). */
function normalizePage(page) {
  return String(page)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.[^./]+$/, '')
}

/**
 * Find the page file a `page:` entry refers to (any renderer extension).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 * @param {string} page
 * @returns {{ abs: string, renderer: import('@mkadoc/plugin-host').MkadocRenderer } | null}
 */
function findPageFile(host, source, page) {
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
async function metaLabelFor(absPath, renderer) {
  const meta = await pageMeta(absPath, renderer)
  return String(meta.navLabel || meta.title || '').trim()
}

/**
 * Derive a `page:` entry's label from the page's own nav label/title.
 * Returns '' when the page has no label (caller falls back to `label`/basename).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 * @param {string} page
 */
async function derivePageLabel(host, source, page) {
  const found = findPageFile(host, source, page)
  if (!found) return ''
  return metaLabelFor(found.abs, found.renderer)
}

/**
 * Resolve a repo-relative page path's nav label (used by the classifier).
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {string} relPath
 */
async function pageLabelForRel(host, relPath) {
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
function flattenPageItems(items, out = []) {
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
 * @param {import('../sources.js').MkadocSource} source
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
 * @param {import('../sources.js').MkadocSource} source
 */
async function resolveSourceEntry(host, source) {
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
 * Update the classifier state with the pages whose labels feed this source's nav.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 */
async function collectNavReferenced(host, source) {
  // Rich `_nav.adoc` labels are inline, not page-derived — nothing to track.
  if (fs.existsSync(path.join(host.root, source.path, '_nav.adoc'))) return

  const items = readNavYaml(host, source)
  if (items?.length) {
    for (const item of flattenPageItems(items)) {
      const found = findPageFile(host, source, item.page)
      if (!found) continue
      const rel = relToRoot(found.abs, host.root)
      navState(host).referenced.add(rel)
      const label = await metaLabelFor(found.abs, found.renderer)
      navState(host).labels.set(rel, label)
    }
    return
  }

  // Auto-nav: every page in the convention tree feeds a label.
  const root = await buildFolder(host, source, source.path)
  await collectAutoNavRefs(host, root)
}

/**
 * Walk an auto-nav tree and record each page's repo path + resolved label.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {{ rel: string | null, children: object[] }} node
 */
async function collectAutoNavRefs(host, node) {
  if (node.rel) {
    navState(host).referenced.add(node.rel)
    navState(host).labels.set(node.rel, await pageLabelForRel(host, node.rel))
  }
  for (const child of node.children) {
    await collectAutoNavRefs(host, child)
  }
}

/** Render a validated `_nav.yaml` item tree to sidebar HTML. */
async function renderYamlNav(items, host, source) {
  const renderItem = async (item) => {
    const hasChildren = Boolean(item.children?.length)
    let label = ''
    let href = null

    if (item.page) {
      href = navPageHref(source, item.page)
      const derived = await derivePageLabel(host, source, item.page)
      label = derived || item.label || path.basename(normalizePage(item.page))
    } else {
      label = item.label || ''
      href = item.href ?? null
    }

    const labelHtml = escapeHtml(label)
    const linkHtml = href ? `<a href="${escapeHtmlAttr(href)}">${labelHtml}</a>` : ''
    const headHtml = linkHtml ? `<p>${linkHtml}</p>` : `<p>${labelHtml}</p>`

    if (hasChildren) {
      const kids = (await Promise.all(item.children.map(renderItem))).join('\n')
      return `<li>${headHtml}\n<ul>\n${kids}\n</ul></li>`
    }
    return `<li>${headHtml}</li>`
  }
  const listHtml = (await Promise.all(items.map(renderItem))).join('\n')
  return `<div class="ulist"><ul>\n${listHtml}\n</ul></div>\n`
}

/**
 * Read + validate `<source>/_nav.yaml`, or return null when absent.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 */
function readNavYaml(host, source) {
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

async function readNavCssBundle(host) {
  const cssParts = [SOURCES_CSS, DEFAULT_NAV_CSS]
  const first = host.config.sources[0]
  if (first) {
    const override = readThemeOverride(host.root, first, 'nav.css')
    if (override) {
      cssParts.push(`/* Overrides from ${themeDirForSource(first)}/nav.css */\n${override}`)
    }
  }
  return `${cssParts.join('\n\n').trim()}\n`
}

/**
 * Level-2 article sidebar: one `data-mount` list per source, contributed via
 * host.contributeChromeBody.
 * Nav sources, in precedence order: `_nav.adoc` (rich markup), `_nav.yaml`
 * (declarative), else an auto-generated page list. No other formats.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 */
async function buildArticlesHtml(host) {
  const adocRenderer = host.renderers.find((r) => r.extensions?.includes('.adoc'))
  const lists = []
  for (const source of host.config.sources) {
    let html = ''
    const adocPath = path.join(host.root, source.path, '_nav.adoc')
    if (adocRenderer && fs.existsSync(adocPath)) {
      const sourceText = fs.readFileSync(adocPath, 'utf8')
      html = await adocRenderer.renderFragment({
        sourceText,
        absPath: adocPath,
        baseDir: path.join(host.root, source.path),
        linkPrefix: mountPrefix(source.mount),
      })
    } else {
      const items = readNavYaml(host, source)
      if (items) html = await renderYamlNav(items, host, source)
    }
    if (!String(html).trim()) {
      html = await autoNavHtml(host, source)
    }
    lists.push(
      `<div class="mkadoc-article-list" data-mount="${escapeHtmlAttr(source.mount)}">\n${html}\n</div>`,
    )
  }

  return `<aside id="mkadoc-articles" class="mkadoc-articles">
<div class="mkadoc-article-lists">
${lists.join('\n')}
</div>
</aside>`
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function navPlugin(rawOptions = {}, host) {
  parsePluginOptions('mkadoc:nav', OptionsSchema, rawOptions)

  return host.plugin([], () => ({
    name: 'nav',

    async setup(host) {
      for (const source of host.config.sources) {
        host.registerSiteWideDep(`${source.path}/_nav.adoc`)
        host.registerSiteWideDep(`${source.path}/_nav.yaml`)
      }

      // A nav-referenced page forces a full rebuild only when its label
      // (`:nav_label:`/title) actually changed — not on content-only edits.
      const { referenced, labels } = navState(host)
      host.registerClassifier(async (relPath) => {
        if (!referenced.has(relPath)) return null
        const current = await pageLabelForRel(host, relPath)
        return current !== (labels.get(relPath) ?? '') ? 'full' : null
      })
    },

    async contributeChrome(host, { mode }) {
      if (mode === 'assets') return

      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const jsAsset = resolveSiteAsset(host.root, host.config.output, JS_HREF)
      writeIfChanged(cssAsset.absPath, await readNavCssBundle(host))
      writeIfChanged(jsAsset.absPath, `${NAV_JS}\n`)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
        scripts: [{ src: jsAsset.href, defer: true }],
      })

      const entries = []
      for (const source of host.config.sources) {
        entries.push({ source, ...(await resolveSourceEntry(host, source)) })
      }

      // Refresh classifier state for the next rebuild.
      const { referenced, labels } = navState(host)
      referenced.clear()
      labels.clear()
      for (const source of host.config.sources) {
        await collectNavReferenced(host, source)
      }

      // Nav-owned home: where `/` redirects, published as a service.
      const first = entries[0]
      host.provideService('site-root', { href: first?.href ?? null })

      host.contributeChromeBody(
        `<nav class="mkadoc-sources" aria-label="Sources">\n${sourcesBarHtml(entries)}\n</nav>\n${await buildArticlesHtml(host)}`,
      )
    },

    async check(host) {
      const notes = []
      let ok = host.config.sources.length > 0
      const first = host.config.sources[0]
      if (first) {
        const override = readThemeOverride(host.root, first, 'nav.css')
        notes.push(
          override
            ? `${themeDirForSource(first)}/nav.css style overrides ok`
            : 'nav using plugin CSS defaults',
        )
      }

      for (const source of host.config.sources) {
        const adocPath = path.join(host.root, source.path, '_nav.adoc')
        const yamlPath = path.join(host.root, source.path, '_nav.yaml')
        if (fs.existsSync(adocPath)) {
          notes.push(`${source.path}/_nav.adoc ok`)
        } else if (fs.existsSync(yamlPath)) {
          try {
            readNavYaml(host, source)
            notes.push(`${source.path}/_nav.yaml ok`)
          } catch {
            ok = false
            notes.push(`${source.path}/_nav.yaml invalid`)
          }
        } else {
          notes.push(`_nav missing (auto nav)`)
        }
      }

      return { ok, message: notes.join('; ') || 'nav ok' }
    },
  }))
}
