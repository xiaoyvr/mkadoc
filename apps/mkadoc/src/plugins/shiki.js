import fs from 'node:fs'
import path from 'node:path'
import {
  SyntaxHighlighter,
  SyntaxHighlighterBase,
} from '@asciidoctor/core'
import { createHighlighter } from 'shiki'

const DEFAULT_THEME = 'github-light-default'
const DEFAULT_LANGS = [
  'bash',
  'shellscript',
  'nix',
  'javascript',
  'json',
  'yaml',
  'ruby',
  'python',
  'plaintext',
]

const LANG_ALIASES = {
  sh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  js: 'javascript',
}

/** Shared across rebuilds so serve does not leak a Highlighter per build. */
const shared = {
  /** @type {import('shiki').Highlighter | null} */
  highlighter: null,
  /** @type {string | null} */
  key: null,
  theme: DEFAULT_THEME,
  /** @type {{ bg: string, fg: string }} */
  colors: { bg: '#ffffff', fg: '#1f2328' },
  registered: false,
}

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return false
  }
  fs.writeFileSync(filePath, content)
  return true
}

function langListFor(langs) {
  const langList = new Set([...langs, 'plaintext'])
  for (const alias of Object.values(LANG_ALIASES)) langList.add(alias)
  return [...langList].sort()
}

/**
 * Build-time Shiki highlighter (same registration model as tani/asciidoctor-shiki).
 *
 * Theme background/foreground are taken from the loaded Shiki theme (not hardcoded)
 * and written to site/styles/shiki.css so listing blocks match the token colors.
 *
 * @param {object} options
 * @param {string} [options.theme]
 * @param {string[]} [options.langs]
 * @param {string} [options.css_href]
 */
export default function shikiPlugin(options = {}) {
  const theme = options.theme || DEFAULT_THEME
  const langs = Array.isArray(options.langs) && options.langs.length
    ? options.langs
    : DEFAULT_LANGS
  const cssHref = options.css_href || '/styles/shiki.css'

  return {
    name: 'shiki',

    async setup(host) {
      const langsSorted = langListFor(langs)
      const key = `${theme}\0${langsSorted.join(',')}`

      if (!shared.highlighter || shared.key !== key) {
        shared.highlighter?.dispose()
        shared.highlighter = await createHighlighter({
          themes: [theme],
          langs: langsSorted,
        })
        shared.key = key
        shared.theme = theme
        const resolved = shared.highlighter.getTheme(theme)
        shared.colors = {
          bg: resolved.bg || shared.colors.bg,
          fg: resolved.fg || shared.colors.fg,
        }
      }

      host.registerAssetPrefix(
        path.posix.join(host.config.output.replace(/\\/g, '/'), 'styles'),
      )
    },

    async contributeConvert(host) {
      if (!shared.highlighter) {
        throw new Error('mkadoc:shiki: highlighter not initialized (setup failed)')
      }

      if (!shared.registered) {
        class ShikiHighlighter extends SyntaxHighlighterBase {
          /**
           * @param {string} name
           * @param {string} [backend]
           * @param {{ document?: { hasAttribute: Function, getAttribute: Function } }} [opts]
           */
          constructor(name, backend, opts = {}) {
            super(name, backend, opts)
            this.name = 'shiki'
            this._preClass = 'shiki'
            const doc = opts.document
            this.theme =
              (doc &&
                doc.hasAttribute('shiki-theme') &&
                doc.getAttribute('shiki-theme')) ||
              shared.theme
          }

          highlight(_node, source, lang) {
            const h = shared.highlighter
            if (!h) {
              throw new Error('mkadoc:shiki: highlighter disposed')
            }
            let language = LANG_ALIASES[lang] || lang || 'plaintext'
            if (!h.getLoadedLanguages().includes(language)) {
              language = 'plaintext'
            }
            const themeName = h.getLoadedThemes().includes(this.theme)
              ? this.theme
              : shared.theme
            return h.codeToHtml(source, {
              lang: language,
              theme: themeName,
              structure: 'inline',
            })
          }

          handlesHighlighting() {
            return true
          }
        }

        // Asciidoctor 4: register(adapter, ...names)
        SyntaxHighlighter.register(ShikiHighlighter, 'shiki')
        shared.registered = true
      }

      // Keep adapter defaults in sync when theme changes without re-registering.
      shared.theme = theme

      host.addAttributes({
        'source-highlighter': 'shiki',
        'shiki-theme': theme,
      })
    },

    async afterChrome(host) {
      const cssPath = path.join(
        host.root,
        host.config.output,
        'styles',
        path.basename(cssHref),
      )
      const css = `/* Generated from Shiki theme: ${theme} — do not edit. */
.listingblock > .content > pre.shiki,
.listingblock > .content > pre.shiki code {
  background: ${shared.colors.bg};
  color: ${shared.colors.fg};
}
`
      writeIfChanged(cssPath, css)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssHref }],
      })
    },

    async check() {
      if (!shared.highlighter) {
        return { ok: false, message: 'highlighter not initialized' }
      }
      try {
        shared.highlighter.codeToHtml('echo test', {
          lang: 'bash',
          theme,
          structure: 'inline',
        })
        return {
          ok: true,
          message: `shiki ok (theme=${theme}, bg=${shared.colors.bg}, langs=${shared.highlighter.getLoadedLanguages().length})`,
        }
      } catch (err) {
        return { ok: false, message: err.message }
      }
    },
  }
}
