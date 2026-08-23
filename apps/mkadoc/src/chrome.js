import { load } from '@asciidoctor/core'
import { relToRoot } from './fs-utils.js'

/**
 * Split AsciiDoc into markup vs `[mkadoc-css]` blocks using the Asciidoctor
 * parser. Blocks styled `mkadoc-css` (delimiters `----`, `++++`, `....`) are
 * extracted; `////` comment blocks are not visible to the parser and cannot
 * be used. Shared by the `mkadoc:topbar` (`_chrome.adoc`) and `mkadoc:nav`
 * (`_nav.adoc`) builtins.
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

/**
 * Site chrome assembly. Nothing here is core-owned markup: the topbar
 * (`mkadoc:topbar`), source bar + article sidebar (`mkadoc:nav`), and any
 * other fragments are contributed via `host.contributeChromeBody`. Core only
 * concatenates them into the shared `docinfo-header` and marks the header
 * provided so pages embed it.
 *
 * `_chrome.adoc` edits (site topbar CSS overrides) are classified as
 * assets-only by decide-mode; the CSS rewrite itself belongs to mkadoc:topbar.
 *
 * @param {import('./plugin/contract.js').MkadocBuildHost} host
 * @param {{ mode: string, paths?: string[], deps?: import('./deps.js').DependencyGraph | null }} ctx
 */
export async function writeSiteChrome(host, { mode, paths = [], deps = null }) {
  if (mode === 'assets') return

  const relPaths = paths.map((p) => relToRoot(p, host.root))
  const siteWideTouched = relPaths.some((p) => deps?.isSiteWide(p))

  const needChrome = mode === 'full' || siteWideTouched || !host.headerDocinfoExists()

  if (needChrome) {
    const body = host.chromeBody.filter(Boolean).join('\n').trim()
    await host.writeHeaderDocinfo(`${body}\n`)
  }

  host.markHeaderProvided()
}
