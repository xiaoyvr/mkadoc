import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSiteAsset, writeIfChanged } from './fs-utils.js'
import { chromePathForSource, isSourceIndexPath } from './sources.js'

const CSS_HREF = '/styles/chrome.css'
const JS_HREF = '/styles/chrome.js'

/** Always applied base chrome styles; first-source `[mkadoc-css]` appends overrides. */
const DEFAULT_CHROME_CSS = fs
  .readFileSync(fileURLToPath(new URL('./chrome-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Prefer `////` delimiters so a missed strip still hides the body as an AsciiDoc comment
 * (unlike `----`, which renders as a listing).
 */
const MKADOC_CSS_BLOCK_RE =
  /\[mkadoc-css\][^\n]*\n(?:----|\+\+\+\+|\/{4}|\.{4})\n([\s\S]*?)\n(?:----|\+\+\+\+|\/{4}|\.{4})/g

/**
 * Split AsciiDoc into markup vs `[mkadoc-css]` blocks.
 * @param {string} sourceText
 */
export function extractMkadocCss(sourceText) {
  const css = []
  const re = new RegExp(MKADOC_CSS_BLOCK_RE.source, 'g')
  let match = re.exec(sourceText)
  while (match) {
    const body = String(match[1] || '').trim()
    if (body) css.push(body)
    match = re.exec(sourceText)
  }
  const markupSource = sourceText.replace(new RegExp(MKADOC_CSS_BLOCK_RE.source, 'g'), '\n').trim()
  return {
    css: css.join('\n\n').trim(),
    markupSource,
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
  return source.mount === '/' ? '/index.html' : `${source.mount}/index.html`
}

/**
 * Core chrome: topbar/tabs + empty body region for plugins.
 * @param {import('./sources.js').MkadocSource[]} sources
 * @param {string[]} bodyParts HTML from host.contributeChromeBody
 */
export function buildChromeHtml(sources, bodyParts = []) {
  const brand = escapeHtml(sources[0]?.title || 'Docs')
  const tabs = sources
    .map((source) => {
      const href = tabHref(source)
      return `<a class="mkadoc-tab" data-mount="${escapeHtmlAttr(source.mount)}" href="${escapeHtmlAttr(href)}">${escapeHtml(source.title)}</a>`
    })
    .join('\n')

  const body = bodyParts.filter(Boolean).join('\n')

  return `<header id="mkadoc-topbar" class="mkadoc-topbar">
<div class="mkadoc-brand"><p>${brand}</p></div>
<nav class="mkadoc-tabs" aria-label="Documentation sections">
${tabs}
</nav>
</header>
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
    if (mount === "/") return 0;
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
function readFirstSourceChromeCss(cfg) {
  const cssParts = [DEFAULT_CHROME_CSS]
  const first = cfg.sources[0]
  if (!first) return cssParts.join('\n\n').trim()

  const chromeText = readFirstSourceFile(cfg, chromePathForSource(first))
  const chrome = chromeText ? extractMkadocCss(chromeText) : { css: '' }
  if (chrome.css) {
    cssParts.push(`/* Overrides from first source _chrome.adoc */\n${chrome.css}`)
  }

  return cssParts.join('\n\n').trim()
}

/**
 * Core site chrome: section tabs from `sources` + `#mkadoc-chrome-body` for plugins.
 * CSS: always `chrome-default.css`, then optional first-source `_chrome.adoc` (`[mkadoc-css]`).
 * JS: always package `CHROME_JS` → `/styles/chrome.js`.
 *
 * @param {import('./plugin/contract.js').MkadocBuildHost} host
 * @param {{ mode: string, paths?: string[] }} ctx
 */
export async function writeSiteChrome(host, { mode, paths = [] }) {
  if (mode === 'assets') return
  if (!host.config.sources.length) return

  const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
  const jsAsset = resolveSiteAsset(host.root, host.config.output, JS_HREF)

  const indexTouched = paths.some((p) => isSourceIndexPath(host.config.sources, p))
  const needChrome =
    mode === 'full' ||
    indexTouched ||
    !host.headerDocinfoExists() ||
    !fs.existsSync(cssAsset.absPath) ||
    !fs.existsSync(jsAsset.absPath)

  if (needChrome) {
    const css = readFirstSourceChromeCss(host.config)
    const chrome = buildChromeHtml(host.config.sources, host.chromeBody)
    writeIfChanged(cssAsset.absPath, `${css}\n`)
    writeIfChanged(jsAsset.absPath, `${CHROME_JS}\n`)
    await host.writeHeaderDocinfo(chrome)
  }

  host.contributeHead({
    links: [{ rel: 'stylesheet', href: cssAsset.href }],
    scripts: [{ src: jsAsset.href, defer: true }],
  })
  host.markHeaderProvided()
}
