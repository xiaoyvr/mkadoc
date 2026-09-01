import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { escapeHtml, escapeHtmlAttr } from '../../html-utils.js'
import { mountPrefix } from '../../sources.js'
import { readThemeOverride, themeDirForSource } from '../../theme.js'
import { buildFolder, derivePageLabel, navPageHref, normalizePage, readNavYaml } from './model.js'

/**
 * Nav HTML/CSS rendering: the source-bar, the article sidebar, auto-nav and
 * `_nav.yaml` HTML, and the nav CSS/JS assets. Pure — no session state, no
 * chrome orchestration (see `nav.js`); the data model lives in `model.js`.
 */

/**
 * Level-1 source bar: one link per top-level source (`data-mount`), rendered
 * as a bar under the topbar. Plugin chrome stylesheets are linked *after*
 * the core theme.css in the head, so this asset's own rules win ties with
 * theme.css defaults — including `_theme/theme.css` overrides (which theme.js
 * appends at the end of the theme.css bundle).
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
  .readFileSync(fileURLToPath(new URL('../nav-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Site navigation runtime (one asset): mark the current article, drive the
 * fixed article sidebar's scroll offset, and activate the active source + its
 * article list. Self-contained — derives the active mount from the URL the
 * same way core used to (longest `data-mount` matching the path).
 */
export const NAV_JS = fs
  .readFileSync(fileURLToPath(new URL('../nav-client.js', import.meta.url)), 'utf8')
  .trim()

/** Level-1 bar: one entry per source (clickable only when it has a href). */
export function sourcesBarHtml(entries) {
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

/** @param {import('@mkadoc/plugin-host').MkadocPluginHost} host */
export async function readNavCssBundle(host) {
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
export async function buildArticlesHtml(host) {
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
