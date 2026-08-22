import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from '@asciidoctor/core'
import { relToRoot, resolveSiteAsset, writeIfChanged } from './fs-utils.js'
import { chromePathForSource } from './sources.js'

const CSS_HREF = '/styles/chrome.css'
const JS_HREF = '/styles/chrome.js'
const DEFAULT_LOGO_HREF = '/styles/default-logo.svg'
const DEFAULT_LOGO_SRC = fileURLToPath(new URL('./assets/default-logo.svg', import.meta.url))
/** Prefer SVG, then PNG. First source only. */
export const LOGO_OVERRIDE_NAMES = Object.freeze(['logo.svg', 'logo.png'])

/** Always applied base chrome styles; first-source `[mkadoc-css]` appends overrides. */
const DEFAULT_CHROME_CSS = fs
  .readFileSync(fileURLToPath(new URL('./chrome-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Site logo: first-source `_assets/logo.svg` or `logo.png`, else package default.
 * @param {{ root: string, sources: import('./sources.js').MkadocSource[] }} cfg
 */
export function resolveLogoHref(cfg) {
  const first = cfg.sources[0]
  if (!first) return DEFAULT_LOGO_HREF
  for (const name of LOGO_OVERRIDE_NAMES) {
    const rel = `${first.path}/_assets/${name}`
    if (fs.existsSync(path.join(cfg.root, rel))) {
      return `${first.mount}/_assets/${name}`
    }
  }
  return DEFAULT_LOGO_HREF
}

/** True when `relPath` is the first source's logo override file. */
export function isFirstSourceLogoPath(sources, relPath) {
  const first = sources[0]
  if (!first) return false
  return LOGO_OVERRIDE_NAMES.some((name) => relPath === `${first.path}/_assets/${name}`)
}

/**
 * Core site-wide deps: every page embeds tab chrome from each `index.adoc` and
 * the logo href from the first-source override paths.
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('./deps.js').DependencyGraph} deps
 */
export function registerCoreSiteWideDeps(cfg, deps) {
  for (const source of cfg.sources) {
    deps.addSiteWide(`${source.path}/index.adoc`)
  }
  const first = cfg.sources[0]
  if (!first) return
  for (const name of LOGO_OVERRIDE_NAMES) {
    deps.addSiteWide(`${first.path}/_assets/${name}`)
  }
}

/**
 * Split AsciiDoc into markup vs `[mkadoc-css]` blocks using the Asciidoctor
 * parser. Blocks styled `mkadoc-css` (delimiters `----`, `++++`, `....`) are
 * extracted; `////` comment blocks are not visible to the parser and cannot
 * be used.
 * @param {string} sourceText
 * @returns {Promise<{ css: string, markupSource: string }>}
 */
export async function extractMkadocCss(sourceText) {
  const doc = await load(sourceText, {
    safe: 'unsafe',
    standalone: false,
    sourcemap: true,
  })

  const css = []
  const strip = new Set()
  const lines = sourceText.split('\n')

  for (const block of doc.findBy((b) => b.getStyle() === 'mkadoc-css')) {
    const body = String(block.getSource?.() || '').trim()
    if (body) css.push(body)

    // `getLineNumber()` points at the first delimiter (1-indexed); remove the
    // `[mkadoc-css]` attribute line, both delimiters, and the block body.
    const first = block.getLineNumber?.()
    if (Number.isFinite(first)) {
      const span = block.getSourceLines?.().length || 0
      for (let n = first - 1; n <= first + span + 1; n++) strip.add(n)
    }
  }

  return {
    css: css.join('\n\n').trim(),
    markupSource: lines
      .filter((_, i) => !strip.has(i + 1))
      .join('\n')
      .trim(),
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtmlAttr(value) {
  return escapeHtml(value)
}

function tabHref(source) {
  return `${source.mount}/index.html`
}

/**
 * Core chrome: topbar/tabs + empty body region for plugins.
 * @param {import('./sources.js').MkadocSource[]} sources
 * @param {string[]} bodyParts HTML from host.contributeChromeBody
 * @param {{ logoSrc?: string }} [opts]
 */
export function buildChromeHtml(sources, bodyParts = [], { logoSrc = DEFAULT_LOGO_HREF } = {}) {
  const first = sources[0]
  const homeHref = first ? tabHref(first) : '/'
  const brandRaw = first?.description || first?.title || 'Docs'
  const brand = escapeHtml(brandRaw)
  const tabs = sources
    .map((source) => {
      const href = tabHref(source)
      return `<a class="mkadoc-tab" data-mount="${escapeHtmlAttr(source.mount)}" href="${escapeHtmlAttr(href)}">${escapeHtml(source.title)}</a>`
    })
    .join('\n')

  const body = bodyParts.filter(Boolean).join('\n')
  const logo = `<a class="mkadoc-logo" href="${escapeHtmlAttr(homeHref)}" aria-label="Home"><img src="${escapeHtmlAttr(logoSrc)}" alt=""></a>`

  return `<header id="mkadoc-topbar" class="mkadoc-topbar">
${logo}
<div class="mkadoc-brand" data-site-title="${escapeHtmlAttr(brandRaw)}"><p>${brand}</p></div>
</header>
<nav class="mkadoc-tabs" aria-label="Documentation sections">
${tabs}
</nav>
<div id="mkadoc-chrome-body" class="mkadoc-chrome-body">
${body}
</div>
`
}

/** Tab active-state + optional sidebar current-link script (no-ops if nav absent). */
const CHROME_JS = `(function () {
  var path = location.pathname;
  if (path.endsWith("/")) path += "index.html";

  function mountMatchLen(mount) {
    var prefix = mount.endsWith("/") ? mount : mount + "/";
    if (path === mount || path === mount + ".html") return mount.length;
    if (path.startsWith(prefix)) return mount.length;
    return -1;
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".mkadoc-tab"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".mkadoc-tab-panel"));
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

  document.querySelectorAll("#mkadoc-sidebar a").forEach(function (a) {
    if (a.classList.contains("mkadoc-tab")) return;
    if (a.getAttribute("href") === path) a.classList.add("current");
  });

  // The sticky topbar keeps the site title floating; swap it to the document
  // title once the article h1 scrolls under the bar. The sidebar rides up
  // with the scrolling tabs until it sits flush below the floating title.
  var root = document.documentElement;
  var topbar = document.getElementById("mkadoc-topbar");
  var tabs = document.querySelector(".mkadoc-tabs");
  var tabsHeight = tabs ? tabs.offsetHeight : 0;
  var sidebar = document.querySelector(".mkadoc-sidebar");
  var sidebarTop = sidebar ? sidebar.getBoundingClientRect().top : 0;
  var topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
  var maxOffset = Math.max(sidebarTop - topbarBottom, 0);
  var brand = document.querySelector(".mkadoc-brand");
  var brandEl = brand ? brand.querySelector("p") : null;
  var siteTitle = (brand ? brand.getAttribute("data-site-title") : "") || "";
  var h1 = document.querySelector("#header h1");
  var docTitle = h1 ? String(h1.textContent || "").trim() : "";
  var ticking = false;

  function setBrand(text) {
    if (!brandEl || brandEl.textContent === text) return;
    brandEl.textContent = text;
    brandEl.classList.remove("mkadoc-brand-swap");
    void brandEl.offsetWidth;
    brandEl.classList.add("mkadoc-brand-swap");
  }

  function updateBrand() {
    ticking = false;
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    // Once the tabs have fully scrolled under the bar, the floating title
    // needs its own bottom line.
    root.classList.toggle("mkadoc-scrolled", y >= tabsHeight);
    if (maxOffset > 0) {
      root.style.setProperty(
        "--mkadoc-scroll-offset",
        Math.min(Math.max(y, 0), maxOffset) + "px",
      );
    }
    if (!topbar || !h1) {
      setBrand(siteTitle);
      return;
    }
    var past = h1.getBoundingClientRect().bottom <= topbar.getBoundingClientRect().bottom;
    setBrand(past && docTitle ? docTitle : siteTitle);
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateBrand);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  updateBrand();
})();
`

function readFirstSourceFile(cfg, relPath) {
  const abs = path.join(cfg.root, relPath)
  if (!fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8')
}

/**
 * Package chrome defaults always apply; first source may append topbar overrides.
 * Below-topbar UI/CSS is owned by plugins via contributeChromeBody.
 */
async function readFirstSourceChromeCss(cfg) {
  const cssParts = [DEFAULT_CHROME_CSS]
  const first = cfg.sources[0]
  if (!first) return cssParts.join('\n\n').trim()

  const chromeText = readFirstSourceFile(cfg, chromePathForSource(first))
  const chrome = chromeText ? await extractMkadocCss(chromeText) : { css: '' }
  if (chrome.css) {
    cssParts.push(`/* Overrides from first source _chrome.adoc */\n${chrome.css}`)
  }

  return cssParts.join('\n\n').trim()
}

/**
 * Core site chrome: section tabs from `sources` + `#mkadoc-chrome-body` for plugins.
 * CSS: always `chrome-default.css`, then optional first-source `_chrome.adoc` (`[mkadoc-css]`).
 * JS: always package `CHROME_JS` → `/styles/chrome.js`.
 * Logo: package default `/styles/default-logo.svg`, overridden by first-source
 * `_assets/logo.svg` or `logo.png` (no config); links to first-source home.
 *
 * @param {import('./plugin/contract.js').MkadocBuildHost} host
 * @param {{ mode: string, paths?: string[], deps?: import('./deps.js').DependencyGraph | null }} ctx
 */
export async function writeSiteChrome(host, { mode, paths = [], deps = null }) {
  if (!host.config.sources.length) return

  const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
  const jsAsset = resolveSiteAsset(host.root, host.config.output, JS_HREF)
  const relPaths = paths.map((p) => relToRoot(p, host.root))

  const chromeCssTouched = relPaths.some((p) =>
    host.config.sources.some((source) => chromePathForSource(source) === p),
  )
  const siteWideTouched = relPaths.some((p) => deps?.isSiteWide(p))

  // `_chrome.adoc` only changes the linked stylesheet — rewrite CSS without a full
  // header/page rebuild when this is an assets-only pass.
  if (mode === 'assets') {
    if (chromeCssTouched) {
      const css = await readFirstSourceChromeCss(host.config)
      writeIfChanged(cssAsset.absPath, `${css}\n`)
    }
    return
  }

  const defaultLogoAsset = resolveSiteAsset(host.root, host.config.output, DEFAULT_LOGO_HREF)
  const needChrome =
    mode === 'full' ||
    siteWideTouched ||
    chromeCssTouched ||
    !host.headerDocinfoExists() ||
    !fs.existsSync(cssAsset.absPath) ||
    !fs.existsSync(jsAsset.absPath) ||
    !fs.existsSync(defaultLogoAsset.absPath)

  if (needChrome) {
    const css = await readFirstSourceChromeCss(host.config)
    const logoSrc = resolveLogoHref(host.config)
    const chrome = buildChromeHtml(host.config.sources, host.chromeBody, { logoSrc })
    writeIfChanged(cssAsset.absPath, `${css}\n`)
    writeIfChanged(jsAsset.absPath, `${CHROME_JS}\n`)
    writeIfChanged(defaultLogoAsset.absPath, fs.readFileSync(DEFAULT_LOGO_SRC, 'utf8'))
    await host.writeHeaderDocinfo(chrome)
  }

  host.contributeHead({
    links: [{ rel: 'stylesheet', href: cssAsset.href }],
    scripts: [{ src: jsAsset.href, defer: true }],
  })
  host.markHeaderProvided()
}
