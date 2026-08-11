import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { writeIfChanged } from '../fs-utils.js'

/**
 * Load _nav.adoc, extract tagged passthrough blocks via the Asciidoctor AST,
 * remove them from the tree, and convert the remaining sidebar body.
 *
 * Tagged blocks:
 *   [mkadoc-nav-css]++++ … ++++  → style mkadoc-nav-css
 *   [mkadoc-nav-js]++++ … ++++   → style mkadoc-nav-js
 *
 * @param {string} source
 * @returns {Promise<{ css: string, js: string, html: string }>}
 */
export async function extractNavChrome(source) {
  const doc = await load(source, {
    safe: 'unsafe',
    standalone: false,
    attributes: {
      icons: 'font',
      relfileprefix: '/',
    },
  })

  function take(style) {
    let text = ''
    // Collect first, then mutate — findBy iteration is not safe to splice mid-loop.
    const matched = [...doc.findBy((b) => b.getStyle() === style)]
    for (const block of matched) {
      const chunk = block.getSource?.() ?? (block.lines || []).join('\n')
      if (chunk) text += chunk.endsWith('\n') ? chunk : `${chunk}\n`
      const parent = block.getParent()
      const blocks = parent.getBlocks()
      const i = blocks.indexOf(block)
      if (i >= 0) blocks.splice(i, 1)
    }
    return text
  }

  const css = take('mkadoc-nav-css')
  const js = take('mkadoc-nav-js')
  const html = await doc.convert()
  return { css, js, html: String(html) }
}

/**
 * @param {object} options
 */
export default function navPlugin(options = {}) {
  const nav = options.nav || 'docs/_nav.adoc'
  const cssHref = options.css_href || '/styles/nav.css'
  const jsHref = options.js_href || '/styles/nav.js'

  return {
    name: 'nav',

    async setup(host) {
      const navRel = host.relToRoot(path.resolve(host.root, nav))
      host.registerClassifier((p) => (p === navRel ? 'full' : null))
      host.addAttributes({ icons: 'font' })
    },

    async contributeChrome(host, { mode }) {
      if (mode === 'assets') return

      const stylesDir = path.join(host.root, host.config.output, 'styles')
      const cssPath = path.join(stylesDir, path.basename(cssHref))
      const jsPath = path.join(stylesDir, path.basename(jsHref))

      const needChrome =
        mode === 'full' ||
        !host.headerDocinfoExists() ||
        !fs.existsSync(cssPath) ||
        !fs.existsSync(jsPath)

      if (needChrome) {
        const source = fs.readFileSync(path.resolve(host.root, nav), 'utf8')
        const { css, js, html } = await extractNavChrome(source)
        if (css) writeIfChanged(cssPath, css)
        if (js) writeIfChanged(jsPath, js)
        await host.writeHeaderDocinfo(html)
      }

      const links = []
      const scripts = []
      if (fs.existsSync(cssPath)) {
        links.push({ rel: 'stylesheet', href: cssHref })
      }
      if (fs.existsSync(jsPath)) {
        scripts.push({ src: jsHref, defer: true })
      }
      host.contributeHead({ links, scripts })
      host.markHeaderProvided()
    },

    async check(host) {
      const abs = path.resolve(host.root, nav)
      if (!fs.existsSync(abs)) {
        return { ok: false, message: `nav not found: ${nav}` }
      }

      const source = fs.readFileSync(abs, 'utf8')
      const { html } = await extractNavChrome(source)
      if (!String(html).trim()) {
        return {
          ok: false,
          message: `${nav} produced empty sidebar HTML after extracting css/js blocks`,
        }
      }
      return { ok: true, message: `nav ok (${nav})` }
    },
  }
}
