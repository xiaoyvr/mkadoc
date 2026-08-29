import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { formatConfigZodError } from '../config-schema.js'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtml, escapeHtmlAttr } from '../html-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import { findSourceFile, listSourcePages, mountPrefix, pageToHref } from '../sources.js'
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
const NAV_JS = `(function () {
  var path = location.pathname;
  if (path.endsWith("/")) path += "index.html";

  function mountMatch(mount) {
    var m = mount || "/";
    var prefix = m.endsWith("/") ? m : m + "/";
    if (path === m || path === m + ".html") return m.length;
    if (path.startsWith(prefix)) return m.length;
    return -1;
  }

  document.querySelectorAll("#mkadoc-articles a").forEach(function (a) {
    if (a.classList.contains("mkadoc-source")) return;
    if (a.getAttribute("href") === path) a.classList.add("current");
  });

  var root = document.documentElement;
  var topbar = document.getElementById("mkadoc-topbar");
  var topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
  var articles = document.querySelector(".mkadoc-articles");
  if (root && articles) {
    var maxOffset = Math.max(
      articles.getBoundingClientRect().top - topbarBottom,
      0,
    );
    if (maxOffset > 0) {
      var ticking = false;
      function updateOffset() {
        ticking = false;
        var y = window.scrollY || document.documentElement.scrollTop || 0;
        root.style.setProperty(
          "--mkadoc-scroll-offset",
          Math.min(Math.max(y, 0), maxOffset) + "px",
        );
      }
      function onScroll() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(updateOffset);
      }
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      updateOffset();
    }
  }

  var sources = Array.prototype.slice.call(document.querySelectorAll(".mkadoc-source"));
  var best = null;
  var bestLen = -1;
  sources.forEach(function (source) {
    var mount = source.getAttribute("data-mount") || "/";
    var len = mountMatch(mount);
    if (len > bestLen) {
      best = mount;
      bestLen = len;
    }
  });
  if (best == null && sources.length) best = sources[0].getAttribute("data-mount") || "/";
  sources.forEach(function (source) {
    if ((source.getAttribute("data-mount") || "/") === best) source.classList.add("is-active");
  });
  document.querySelectorAll(".mkadoc-article-list").forEach(function (list) {
    if ((list.getAttribute("data-mount") || "/") === best) list.classList.add("is-active");
  });
})();
`

function sourceHref(source) {
  return `${source.mount}/index.html`
}

/** Level-1 bar: one link per source. */
function sourcesBarHtml(sources) {
  return sources
    .map((source) => {
      const href = sourceHref(source)
      return `<a class="mkadoc-source" data-mount="${escapeHtmlAttr(source.mount)}" href="${escapeHtmlAttr(href)}">${escapeHtml(source.title)}</a>`
    })
    .join('\n')
}

function autoNavHtml(host, source) {
  const rendererForPath = (p) =>
    host.renderers.find((r) => r.extensions?.includes(path.extname(p).toLowerCase())) || null
  const pages = listSourcePages(host.root, [source], { rendererForPath })
  if (pages.length === 0) {
    return '<div class="paragraph"><p><em>No pages</em></p></div>\n'
  }
  const items = pages
    .map(({ page }) => {
      const href = pageToHref(source, page)
      const label = path.basename(page, path.extname(page))
      return `<li><p><a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}</a></p></li>`
    })
    .join('\n')
  return `<div class="ulist"><ul>\n${items}\n</ul></div>\n`
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
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 * @param {string} page
 * @returns {{ abs: string, renderer: import('../plugin/contract.js').MkadocRenderer } | null}
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
 * Derive a `page:` entry's label from the page's own title.
 * Returns '' when the page has no title (caller falls back to `label`/basename).
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
 * @param {import('../sources.js').MkadocSource} source
 * @param {string} page
 */
async function derivePageLabel(host, source, page) {
  const found = findPageFile(host, source, page)
  if (!found) return ''
  const text = fs.readFileSync(found.abs, 'utf8')
  const meta = await found.renderer.extractMeta(text, found.abs)
  return String(meta.title || '').trim()
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
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
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
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
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
        attributes: { icons: 'font', relfileprefix: mountPrefix(source.mount) },
      })
    } else {
      const items = readNavYaml(host, source)
      if (items) html = await renderYamlNav(items, host, source)
    }
    if (!String(html).trim()) {
      html = autoNavHtml(host, source)
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

/** @type {import('../plugin/contract.js').MkadocPluginFactory} */
export default function navPlugin(rawOptions = {}) {
  parsePluginOptions('mkadoc:nav', OptionsSchema, rawOptions)

  return {
    name: 'nav',

    async setup(host) {
      for (const source of host.config.sources) {
        const indexFile = findSourceFile(host.root, source.path, 'index', host.renderers)
        if (indexFile) host.registerSiteWideDep(indexFile.rel)
        host.registerSiteWideDep(`${source.path}/_nav.adoc`)
        host.registerSiteWideDep(`${source.path}/_nav.yaml`)
      }
      host.addAttributes({ icons: 'font' })
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

      host.contributeChromeBody(
        `<nav class="mkadoc-sources" aria-label="Sources">\n${sourcesBarHtml(host.config.sources)}\n</nav>\n${await buildArticlesHtml(host)}`,
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
  }
}
