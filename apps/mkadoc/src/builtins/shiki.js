import path from 'node:path'
import { createHighlighter } from 'shiki'
import { z } from 'zod'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { parsePluginOptions } from '../plugin/options.js'

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

const OptionsSchema = z
  .object({
    theme: z.string().min(1).default('github-light-default'),
    langs: z
      .array(z.string().min(1))
      .default([...DEFAULT_LANGS])
      .transform((langs) => (langs.length ? langs : [...DEFAULT_LANGS])),
  })
  .strict()

const CSS_HREF = '/styles/shiki.css'
const DEFAULT_THEME = 'github-light-default'

const LANG_ALIASES = {
  sh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  js: 'javascript',
}

const shared = {
  highlighter: null,
  key: null,
  theme: DEFAULT_THEME,
  colors: { bg: '#ffffff', fg: '#1f2328' },
}

function langListFor(langs) {
  const langList = new Set([...langs, 'plaintext'])
  for (const alias of Object.values(LANG_ALIASES)) langList.add(alias)
  return [...langList].sort()
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function shikiPlugin(rawOptions = {}) {
  const { theme, langs } = parsePluginOptions('mkadoc:shiki', OptionsSchema, rawOptions)

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

      if (!shared.highlighter) {
        throw new Error('mkadoc:shiki: highlighter not initialized (setup failed)')
      }

      shared.theme = theme

      // Capability consumed by renderers (mkadoc:asciidoc, mkadoc:markdown, …).
      host.provideService('syntax-highlight', {
        highlight(code, lang) {
          const h = shared.highlighter
          if (!h) {
            throw new Error('mkadoc:shiki: highlighter is not active')
          }
          let language = LANG_ALIASES[lang] || lang || 'plaintext'
          if (!h.getLoadedLanguages().includes(language)) {
            language = 'plaintext'
          }
          const themeName = h.getLoadedThemes().includes(shared.theme)
            ? shared.theme
            : DEFAULT_THEME
          return h.codeToHtml(String(code), {
            lang: language,
            theme: themeName,
            structure: 'inline',
          })
        },
      })

      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const assetDir = path.posix.dirname(cssAsset.relPath)
      const out = host.config.output.replace(/\\/g, '/').replace(/\/$/, '')
      host.registerAssetPrefix(assetDir === '.' ? out : path.posix.join(out, assetDir))
    },

    async contributeChrome(host) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const css = `/* Generated from Shiki theme: ${theme} — do not edit. */
.listingblock > .content > pre.shiki,
.listingblock > .content > pre.shiki code,
pre:has(> code[class*="language-"]) {
  background: ${shared.colors.bg};
  color: ${shared.colors.fg};
}
`
      writeIfChanged(cssAsset.absPath, css)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
      })
    },

    async dispose() {
      // Called when the plugin is unloaded (config change under serve): drop
      // the shared highlighter so it does not linger after removal. Idempotent
      // — a subsequent build with the same config never disposes between
      // rebuilds, so the expensive highlighter is still reused.
      shared.highlighter?.dispose()
      shared.highlighter = null
      shared.key = null
      shared.theme = DEFAULT_THEME
      shared.colors = { bg: '#ffffff', fg: '#1f2328' }
    },
  }
}
