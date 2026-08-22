import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from '@asciidoctor/core'
import { z } from 'zod'
import { extractMkadocCss } from '../chrome.js'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import { listSourcePages, mountPrefix, navPathForSource, pageToHref } from '../sources.js'

const OptionsSchema = z.object({}).strict()
const CSS_HREF = '/styles/nav.css'

const DEFAULT_NAV_CSS = fs
  .readFileSync(fileURLToPath(new URL('./nav-default.css', import.meta.url)), 'utf8')
  .trim()

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

async function readNavCssBundle(host) {
  const cssParts = [DEFAULT_NAV_CSS]
  const first = host.config.sources[0]
  if (first) {
    const navAbs = path.join(host.root, navPathForSource(first))
    if (fs.existsSync(navAbs)) {
      const { css } = await extractMkadocCss(fs.readFileSync(navAbs, 'utf8'))
      if (css) cssParts.push(`/* Overrides from first source _nav.adoc */\n${css}`)
    }
  }
  return `${cssParts.join('\n\n').trim()}\n`
}

/**
 * Build the left sidebar for `#mkadoc-chrome-body`.
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
 */
async function buildSidebarHtml(host) {
  const panels = []
  for (const source of host.config.sources) {
    const navRel = navPathForSource(source)
    const navAbs = path.join(host.root, navRel)
    let html = ''
    if (fs.existsSync(navAbs)) {
      const sourceText = fs.readFileSync(navAbs, 'utf8')
      const { markupSource } = await extractMkadocCss(sourceText)
      if (markupSource) {
        html = await renderNavMarkup(markupSource, {
          relfileprefix: mountPrefix(source.mount),
        })
      }
    }
    if (!String(html).trim()) {
      html = autoNavHtml(host, source)
    }
    panels.push(
      `<div class="mkadoc-tab-panel" data-mount="${escapeHtmlAttr(source.mount)}">\n${html}\n</div>`,
    )
  }

  return `<aside id="mkadoc-sidebar" class="mkadoc-sidebar">
<div class="mkadoc-tab-panels">
${panels.join('\n')}
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
        host.registerSiteWideDep(navPathForSource(source))
      }
      host.addAttributes({ icons: 'font' })
    },

    async contributeChrome(host, { mode }) {
      if (mode === 'assets') return

      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      // Site-wide _nav edits rebuild every page, so CSS may change with markup.
      writeIfChanged(cssAsset.absPath, await readNavCssBundle(host))
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
      })

      host.contributeChromeBody(await buildSidebarHtml(host))
    },

    async check(host) {
      const notes = []
      const first = host.config.sources[0]
      if (first) {
        const navRel = navPathForSource(first)
        const abs = path.join(host.root, navRel)
        if (fs.existsSync(abs)) {
          const { css } = await extractMkadocCss(fs.readFileSync(abs, 'utf8'))
          notes.push(css ? `${navRel} style overrides ok` : `${navRel} using plugin CSS defaults`)
        } else {
          notes.push(`${navRel} missing (auto nav; plugin CSS defaults)`)
        }
      }

      for (const source of host.config.sources) {
        const navRel = navPathForSource(source)
        const abs = path.join(host.root, navRel)
        if (!fs.existsSync(abs)) {
          notes.push(`${navRel} missing (auto nav)`)
          continue
        }
        const { markupSource } = await extractMkadocCss(fs.readFileSync(abs, 'utf8'))
        if (!markupSource) {
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
