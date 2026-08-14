import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { z } from 'zod'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import {
  isSourceIndexPath,
  listSourcePages,
  mountPrefix,
  navPathForSource,
  pageToHref,
} from '../sources.js'

const OptionsSchema = z
  .object({
    css_href: z.string().min(1).default('/styles/nav.css'),
    js_href: z.string().min(1).default('/styles/nav.js'),
  })
  .strict()

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function renderNavMarkup(sourceText, { relfileprefix = '/' } = {}) {
  const doc = await load(sourceText, {
    safe: 'unsafe',
    standalone: false,
    attributes: {
      icons: 'font',
      relfileprefix,
    },
  })
  return String(await doc.convert())
}

function autoNavHtml(host, source) {
  const pages = listSourcePages(host.root, [source])
  if (pages.length === 0) {
    return '<div class="paragraph"><p><em>No pages</em></p></div>\n'
  }
  const items = pages
    .map(({ page }) => {
      const href = pageToHref(source, page)
      const label = path.basename(page, '.adoc')
      return `<li><p><a href="${escapeHtmlAttr(href)}">${escapeHtml(label)}</a></p></li>`
    })
    .join('\n')
  return `<div class="ulist"><ul>\n${items}\n</ul></div>\n`
}

function tabHref(source) {
  return source.mount === '/' ? '/index.html' : `${source.mount}/index.html`
}

function buildTabsChrome(host, panels) {
  const brand = escapeHtml(host.config.sources[0]?.title || 'Docs')
  const tabs = host.config.sources
    .map((source) => {
      const href = tabHref(source)
      return `<a class="docs-tab" data-mount="${escapeHtmlAttr(source.mount)}" href="${escapeHtmlAttr(href)}">${escapeHtml(source.title)}</a>`
    })
    .join('\n')

  const panelHtml = panels
    .map(
      ({ source, html }) =>
        `<div class="docs-tab-panel" data-mount="${escapeHtmlAttr(source.mount)}">\n${html}\n</div>`,
    )
    .join('\n')

  return `<header id="docs-topbar" class="docs-topbar">
<div class="docs-brand"><p>${brand}</p></div>
<nav class="docs-tabs" aria-label="Documentation sections">
${tabs}
</nav>
</header>
<aside id="docs-sidebar" class="docs-sidebar">
<div class="docs-tab-panels">
${panelHtml}
</div>
</aside>
`
}

const DEFAULT_NAV_CSS = `/* Nav chrome: top section tabs + contextual sidebar */

:root {
  --docs-topbar-height: 3rem;
  --docs-sidebar-width: 16rem;
}

.docs-topbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--docs-topbar-height);
  display: flex;
  align-items: stretch;
  gap: 1.5rem;
  padding: 0 1.25rem;
  background: #fff;
  border-bottom: 1px solid #e0e0dc;
  box-sizing: border-box;
  overflow: hidden;
  z-index: 1100;
}

.docs-brand {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  font-family: "Open Sans", "DejaVu Sans", sans-serif;
  font-size: 1.05rem;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.85);
  white-space: nowrap;
}

.docs-brand p {
  margin: 0;
}

.docs-tabs {
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  gap: 0.25rem;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.docs-tabs::-webkit-scrollbar {
  display: none;
}

.docs-tab {
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

.docs-tab:hover,
.docs-tab:focus {
  color: #2156a5;
}

.docs-tab.is-active {
  color: #ba3925;
  font-weight: 600;
  border-bottom-color: #ba3925;
}

.docs-sidebar {
  position: fixed;
  top: var(--docs-topbar-height);
  left: 0;
  bottom: 0;
  width: var(--docs-sidebar-width);
  overflow: auto;
  padding: 1.25rem 1rem;
  background: #f8f8f7;
  border-right: 1px solid #e0e0dc;
  box-sizing: border-box;
  z-index: 1000;
}

.docs-tab-panel {
  display: none;
}

.docs-tab-panel.is-active {
  display: block;
}

.docs-sidebar h1,
.docs-sidebar h2,
.docs-sidebar h3 {
  font-family: "Open Sans", "DejaVu Sans", sans-serif;
  font-weight: 600;
  color: rgba(0, 0, 0, 0.8);
  margin: 0 0 0.75rem;
  line-height: 1.25;
}

.docs-sidebar h1 { font-size: 1.1rem; }
.docs-sidebar h2 {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: rgba(0, 0, 0, 0.55);
}

.docs-sidebar .paragraph { margin: 0 0 0.75rem; }

.docs-sidebar .ulist,
.docs-sidebar ul {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: "Open Sans", "DejaVu Sans", sans-serif;
  font-size: 0.95rem;
  line-height: 1.35;
}

.docs-sidebar li { margin: 0 0 0.35rem; }
.docs-sidebar li > p { margin: 0; }
.docs-sidebar ul ul { margin: 0.25rem 0 0.5rem 0.75rem; }

.docs-sidebar a {
  color: rgba(0, 0, 0, 0.75);
  text-decoration: none;
  display: block;
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
}

.docs-sidebar a:hover,
.docs-sidebar a:focus {
  color: #2156a5;
  background: rgba(33, 86, 165, 0.08);
}

.docs-sidebar a.current {
  color: #ba3925;
  font-weight: 600;
  background: rgba(186, 57, 37, 0.08);
}

@media screen and (min-width: 768px) {
  body:has(#docs-topbar) {
    padding-top: var(--docs-topbar-height);
    padding-left: var(--docs-sidebar-width);
  }
}

@media screen and (max-width: 767px) {
  .docs-topbar {
    position: static;
    height: auto;
    flex-wrap: wrap;
    overflow: visible;
    padding: 0.75rem 1rem 0;
  }

  .docs-tabs {
    width: 100%;
    height: auto;
    border-top: 1px solid #e0e0dc;
    margin-top: 0.5rem;
  }

  .docs-tab {
    height: auto;
    padding: 0.65rem 0.75rem;
  }

  .docs-sidebar {
    position: static;
    width: auto;
    border-right: 0;
    border-bottom: 1px solid #e0e0dc;
  }

  body:has(#docs-topbar) {
    padding-top: 0;
    padding-left: 0;
  }
}
`

const DEFAULT_NAV_JS = `(function () {
  var path = location.pathname;
  if (path.endsWith("/")) path += "index.html";

  function mountMatchLen(mount) {
    if (mount === "/") return 0;
    var prefix = mount.endsWith("/") ? mount : mount + "/";
    if (path === mount || path === mount + ".html") return mount.length;
    if (path.startsWith(prefix)) return mount.length;
    return -1;
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".docs-tab"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".docs-tab-panel"));
  var best = null;
  var bestLen = -1;
  tabs.forEach(function (tab) {
    var mount = tab.getAttribute("data-mount") || "/";
    var len = mountMatchLen(mount);
    if (len > bestLen) {
      best = mount;
      bestLen = len;
    }
  });
  if (best == null && tabs.length) best = tabs[0].getAttribute("data-mount") || "/";

  tabs.forEach(function (tab) {
    var mount = tab.getAttribute("data-mount") || "/";
    if (mount === best) tab.classList.add("is-active");
  });
  panels.forEach(function (panel) {
    var mount = panel.getAttribute("data-mount") || "/";
    if (mount === best) panel.classList.add("is-active");
  });

  document.querySelectorAll("#docs-sidebar a").forEach(function (a) {
    if (a.classList.contains("docs-tab")) return;
    if (a.getAttribute("href") === path) a.classList.add("current");
  });
})();
`

/** @type {import('../plugin/contract.js').MkadocPluginFactory} */
export default function navPlugin(rawOptions = {}) {
  const { css_href: cssHref, js_href: jsHref } = parsePluginOptions(
    'mkadoc:nav',
    OptionsSchema,
    rawOptions,
  )

  return {
    name: 'nav',

    async setup(host) {
      for (const source of host.config.sources) {
        const navRel = navPathForSource(source)
        host.registerClassifier((p) => (p === navRel ? 'full' : null))
      }
      host.addAttributes({ icons: 'font' })
    },

    async contributeChrome(host, { mode, paths = [] }) {
      if (mode === 'assets') return

      const cssAsset = resolveSiteAsset(host.root, host.config.output, cssHref)
      const jsAsset = resolveSiteAsset(host.root, host.config.output, jsHref)

      const indexTouched = paths.some((p) => isSourceIndexPath(host.config.sources, p))
      const needChrome =
        mode === 'full' ||
        indexTouched ||
        !host.headerDocinfoExists() ||
        !fs.existsSync(cssAsset.absPath) ||
        !fs.existsSync(jsAsset.absPath)

      if (needChrome) {
        const panels = []

        for (const source of host.config.sources) {
          const navRel = navPathForSource(source)
          const navAbs = path.join(host.root, navRel)
          let html = ''
          if (fs.existsSync(navAbs)) {
            const sourceText = fs.readFileSync(navAbs, 'utf8')
            html = await renderNavMarkup(sourceText, {
              relfileprefix: mountPrefix(source.mount),
            })
          }
          if (!String(html).trim()) {
            html = autoNavHtml(host, source)
          }
          panels.push({ source, html })
        }

        const chrome = buildTabsChrome(host, panels)
        writeIfChanged(cssAsset.absPath, DEFAULT_NAV_CSS)
        writeIfChanged(jsAsset.absPath, DEFAULT_NAV_JS)
        await host.writeHeaderDocinfo(chrome)
      }

      const links = []
      const scripts = []
      if (fs.existsSync(cssAsset.absPath)) {
        links.push({ rel: 'stylesheet', href: cssAsset.href })
      }
      if (fs.existsSync(jsAsset.absPath)) {
        scripts.push({ src: jsAsset.href, defer: true })
      }
      host.contributeHead({ links, scripts })
      host.markHeaderProvided()
    },

    async check(host) {
      const notes = []

      for (const source of host.config.sources) {
        const navRel = navPathForSource(source)
        const abs = path.join(host.root, navRel)
        if (!fs.existsSync(abs)) {
          notes.push(`${navRel} missing (auto nav)`)
          continue
        }
        const sourceText = fs.readFileSync(abs, 'utf8')
        const html = await renderNavMarkup(sourceText, {
          relfileprefix: mountPrefix(source.mount),
        })
        if (!String(html).trim()) {
          notes.push(`${navRel} empty (auto nav)`)
        } else {
          notes.push(`${navRel} ok`)
        }
      }

      return {
        ok: host.config.sources.length > 0,
        message: notes.join('; ') || 'nav ok',
      }
    },
  }
}
