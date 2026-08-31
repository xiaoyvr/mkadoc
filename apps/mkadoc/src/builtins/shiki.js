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
const DEFAULT_COLORS = { bg: '#ffffff', fg: '#1f2328' }

const LANG_ALIASES = {
  sh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  js: 'javascript',
}

function langListFor(langs) {
  const langList = new Set([...langs, 'plaintext'])
  for (const alias of Object.values(LANG_ALIASES)) langList.add(alias)
  return [...langList].sort()
}

/**
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {string} theme
 * @param {string[]} langs
 */
function syntaxHighlightProvider(theme, langs) {
  // Highlighter + resolved theme colors, owned by the provide closure. The
  // session registry retains the memoized value across rebuilds while `key`
  // is unchanged, so the (expensive) highlighter is built once per session —
  // no module-level cache needed. `onRelease` runs when the value is replaced
  // (theme/langs change) or the plugin is removed from config.
  let highlighter = null
  let colors = { ...DEFAULT_COLORS }

  return {
    key: `${theme}\0${langListFor(langs).join(',')}`,
    onRelease() {
      highlighter?.dispose()
      highlighter = null
    },
    async provider() {
      highlighter?.dispose()
      highlighter = await createHighlighter({
        themes: [theme],
        langs: langListFor(langs),
      })
      const resolved = highlighter.getTheme(theme)
      colors = {
        bg: resolved.bg || colors.bg,
        fg: resolved.fg || colors.fg,
      }
      return {
        // Consumers (renderers) use `highlight`; the extra `colors` field
        // lets this plugin read its own memoized value's theme colors.
        colors,
        highlight(code, lang) {
          if (!highlighter) {
            throw new Error('mkadoc:shiki: highlighter is not active')
          }
          let language = LANG_ALIASES[lang] || lang || 'plaintext'
          if (!highlighter.getLoadedLanguages().includes(language)) {
            language = 'plaintext'
          }
          const themeName = highlighter.getLoadedThemes().includes(theme) ? theme : DEFAULT_THEME
          return highlighter.codeToHtml(String(code), {
            lang: language,
            theme: themeName,
            structure: 'inline',
          })
        },
      }
    },
  }
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function shikiPlugin(rawOptions = {}, host) {
  const { theme, langs } = parsePluginOptions('mkadoc:shiki', OptionsSchema, rawOptions)
  const { key, onRelease, provider } = syntaxHighlightProvider(theme, langs)

  host.provide('syntax-highlight', provider, { key, onRelease })

  // Depends on its own capability so the provider resolves (once per session)
  // and the memoized service — including the resolved theme colors — is
  // available to contributeChrome.
  return host.plugin(['syntax-highlight'], (syntaxHighlight) => ({
    name: 'shiki',

    async setup(host) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const assetDir = path.posix.dirname(cssAsset.relPath)
      const out = host.config.output.replace(/\\/g, '/').replace(/\/$/, '')
      host.registerAssetPrefix(assetDir === '.' ? out : path.posix.join(out, assetDir))
    },

    async contributeChrome(host) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const { colors } = syntaxHighlight
      const css = `/* Generated from Shiki theme: ${theme} — do not edit. */
.listingblock > .content > pre.shiki,
.listingblock > .content > pre.shiki code,
pre:has(> code[class*="language-"]) {
  background: ${colors.bg};
  color: ${colors.fg};
}
`
      writeIfChanged(cssAsset.absPath, css)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
      })
    },
  }))
}
