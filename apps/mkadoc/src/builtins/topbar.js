import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import { readThemeOverride, themeDirForSource } from '../theme.js'

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
export const TOPBAR_JS = `(function () {
  var root = document.documentElement;
  var topbar = document.getElementById("mkadoc-topbar");
  var sourcesNav = document.querySelector(".mkadoc-sources");
  var sourcesHeight = sourcesNav ? sourcesNav.offsetHeight : 0;
  var brand = document.querySelector(".mkadoc-brand");
  var brandEl = brand ? brand.querySelector("p") : null;
  var siteTitle = (brand ? brand.getAttribute("data-site-title") : "") || "";
  // Core-owned, renderer-agnostic: the page wrapper sets data-doc-title from
  // RenderOutput.title, so chrome never parses renderer body markup (a
  // renderer may title with h1, h2, or nothing at all).
  var docTitle = String(document.body.getAttribute("data-doc-title") || "").trim();
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
    if (sourcesNav) root.classList.toggle("mkadoc-scrolled", y >= sourcesHeight);
    if (!topbar || !docTitle) {
      setBrand(siteTitle);
      return;
    }
    // Swap once scrolled past the nav (or past the topbar when there is no
    // nav) — a pure scroll threshold, no body-structure measurement.
    var past = y >= (sourcesNav ? sourcesHeight : topbar.offsetHeight);
    setBrand(past ? docTitle : siteTitle);
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

/** Is `relPath` the first source's `_theme/topbar.css` override? */
function isTopbarCssPath(cfg, relPath) {
  const first = cfg.sources[0]
  if (!first) return false
  return relPath === `${themeDirForSource(first)}/topbar.css`
}

async function readTopbarCssBundle(host) {
  const cssParts = [TOPBAR_CSS]
  const first = host.config.sources[0]
  if (first) {
    const override = readThemeOverride(host.root, first, 'topbar.css')
    if (override) {
      cssParts.push(`/* Overrides from ${themeDirForSource(first)}/topbar.css */\n${override}`)
    }
  }
  return `${cssParts.join('\n\n').trim()}\n`
}

function topbarHtml(host) {
  const brandRaw = host.config.site.brand
  const logoSrc = resolveLogoHref(host.config)

  return `<header id="mkadoc-topbar" class="mkadoc-topbar">
<a class="mkadoc-logo" href="/" aria-label="Home"><img src="${escapeHtmlAttr(logoSrc)}" alt=""></a>
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
      const topbarCssTouched = relPaths.some((p) => isTopbarCssPath(host.config, p))

      // `_theme/topbar.css` only changes the linked stylesheet — rewrite CSS
      // without a full header/page rebuild when this is an assets-only pass.
      if (mode === 'assets') {
        if (topbarCssTouched) {
          writeIfChanged(cssAsset.absPath, await readTopbarCssBundle(host))
        }
        return
      }

      const logoSrc = resolveLogoHref(host.config)
      const defaultLogoAsset = resolveSiteAsset(host.root, host.config.output, DEFAULT_LOGO_HREF)
      const needChrome =
        mode === 'full' ||
        topbarCssTouched ||
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
