import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { extractMkadocCss } from '../chrome.js'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import { chromePathForSource } from '../sources.js'

const OptionsSchema = z.object({}).strict()
const CSS_HREF = '/styles/topbar.css'
const JS_HREF = '/styles/topbar.js'
const DEFAULT_LOGO_HREF = '/styles/default-logo.svg'
const DEFAULT_LOGO_SRC = fileURLToPath(new URL('../assets/default-logo.svg', import.meta.url))

/** Prefer SVG, then PNG. First source only. */
const LOGO_OVERRIDE_NAMES = Object.freeze(['logo.svg', 'logo.png'])

const TOPBAR_CSS = fs
  .readFileSync(fileURLToPath(new URL('./topbar-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Topbar runtime: the sticky site title floats, swapping to the document title
 * once the article h1 scrolls under the bar; the source bar (mkadoc:nav)
 * scrolling away gets its own bottom line. Self-contained — reads core/nav
 * DOM via class/id selectors only.
 */
const TOPBAR_JS = `(function () {
  var root = document.documentElement;
  var topbar = document.getElementById("mkadoc-topbar");
  var sourcesNav = document.querySelector(".mkadoc-sources");
  var sourcesHeight = sourcesNav ? sourcesNav.offsetHeight : 0;
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
    // Once the source bar has fully scrolled under the floating title, it
    // needs its own bottom line (only when a source bar exists).
    if (sourcesNav) root.classList.toggle("mkadoc-scrolled", y >= sourcesHeight);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Site logo: first-source `_assets/logo.svg` or `logo.png`, else package default.
 * @param {{ root: string, sources: import('../sources.js').MkadocSource[] }} cfg
 */
function resolveLogoHref(cfg) {
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
function isLogoPath(cfg, relPath) {
  const first = cfg.sources[0]
  if (!first) return false
  return LOGO_OVERRIDE_NAMES.some((name) => relPath === `${first.path}/_assets/${name}`)
}

/** Is `relPath` any source's `_chrome.adoc` (the site topbar CSS override file)? */
function isChromeCssPath(cfg, relPath) {
  return cfg.sources.some((source) => chromePathForSource(source) === relPath)
}

async function readTopbarCssBundle(host) {
  const cssParts = [TOPBAR_CSS]
  const first = host.config.sources[0]
  if (first) {
    const chromeAbs = path.join(host.root, chromePathForSource(first))
    if (fs.existsSync(chromeAbs)) {
      const { css } = await extractMkadocCss(fs.readFileSync(chromeAbs, 'utf8'))
      if (css) cssParts.push(`/* Overrides from first source _chrome.adoc */\n${css}`)
    }
  }
  return `${cssParts.join('\n\n').trim()}\n`
}

function topbarHtml(host) {
  const first = host.config.sources[0]
  const homeHref = first ? `${first.mount}/index.html` : '/'
  const brandRaw = first?.description || first?.title || 'Docs'
  const logoSrc = resolveLogoHref(host.config)

  return `<header id="mkadoc-topbar" class="mkadoc-topbar">
<a class="mkadoc-logo" href="${escapeHtmlAttr(homeHref)}" aria-label="Home"><img src="${escapeHtmlAttr(logoSrc)}" alt=""></a>
<div class="mkadoc-brand" data-site-title="${escapeHtmlAttr(brandRaw)}"><p>${escapeHtml(brandRaw)}</p></div>
</header>`
}

/** @type {import('../plugin/contract.js').MkadocPluginFactory} */
export default function topbarPlugin(rawOptions = {}) {
  parsePluginOptions('mkadoc:topbar', OptionsSchema, rawOptions)

  return {
    name: 'topbar',

    async setup(host) {
      const first = host.config.sources[0]
      if (!first) return
      for (const name of LOGO_OVERRIDE_NAMES) {
        host.registerSiteWideDep(`${first.path}/_assets/${name}`)
      }
    },

    async contributeChrome(host, { mode, paths = [] }) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const jsAsset = resolveSiteAsset(host.root, host.config.output, JS_HREF)
      const relPaths = paths.map((p) => host.relToRoot(p))
      const chromeCssTouched = relPaths.some((p) => isChromeCssPath(host.config, p))

      // `_chrome.adoc` only changes the linked stylesheet — rewrite CSS without
      // a full header/page rebuild when this is an assets-only pass.
      if (mode === 'assets') {
        if (chromeCssTouched) {
          writeIfChanged(cssAsset.absPath, await readTopbarCssBundle(host))
        }
        return
      }

      const logoSrc = resolveLogoHref(host.config)
      const defaultLogoAsset = resolveSiteAsset(host.root, host.config.output, DEFAULT_LOGO_HREF)
      const needChrome =
        mode === 'full' ||
        chromeCssTouched ||
        !fs.existsSync(cssAsset.absPath) ||
        !fs.existsSync(jsAsset.absPath) ||
        (logoSrc === DEFAULT_LOGO_HREF && !fs.existsSync(defaultLogoAsset.absPath))

      if (needChrome) {
        writeIfChanged(cssAsset.absPath, await readTopbarCssBundle(host))
        writeIfChanged(jsAsset.absPath, `${TOPBAR_JS}\n`)
        if (logoSrc === DEFAULT_LOGO_HREF) {
          writeIfChanged(defaultLogoAsset.absPath, fs.readFileSync(DEFAULT_LOGO_SRC, 'utf8'))
        }
      }

      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
        scripts: [{ src: jsAsset.href, defer: true }],
      })
      host.contributeChromeBody(topbarHtml(host))
    },
  }
}
