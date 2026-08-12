import path from 'node:path'
import { SyntaxHighlighter, SyntaxHighlighterBase } from '@asciidoctor/core'
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
    css_href: z.string().min(1).default('/styles/shiki.css'),
  })
  .strict()

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
  adapterState: 'absent',
}

function langListFor(langs) {
  const langList = new Set([...langs, 'plaintext'])
  for (const alias of Object.values(LANG_ALIASES)) langList.add(alias)
  return [...langList].sort()
}

class ActiveShikiHighlighter extends SyntaxHighlighterBase {
  constructor(name, backend, opts = {}) {
    super(name, backend, opts)
    this.name = 'shiki'
    this._preClass = 'shiki'
    const doc = opts.document
    this.theme =
      (doc?.hasAttribute('shiki-theme') && doc.getAttribute('shiki-theme')) || shared.theme
  }

  highlight(_node, source, lang) {
    const h = shared.highlighter
    if (!h) {
      throw new Error(
        'mkadoc:shiki: highlighter is not active (plugin disabled or disposed; restart serve if this persists)',
      )
    }
    let language = LANG_ALIASES[lang] || lang || 'plaintext'
    if (!h.getLoadedLanguages().includes(language)) {
      language = 'plaintext'
    }
    const themeName = h.getLoadedThemes().includes(this.theme) ? this.theme : shared.theme
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

class InactiveShikiHighlighter extends SyntaxHighlighterBase {
  constructor(name, backend, opts = {}) {
    super(name, backend, opts)
    this.name = 'shiki'
  }

  highlight() {
    throw new Error(
      'mkadoc:shiki: plugin is not enabled in the current config (source-highlighter=shiki is stale)',
    )
  }

  handlesHighlighting() {
    return true
  }
}

function ensureActiveAdapter() {
  if (shared.adapterState === 'active') return

  SyntaxHighlighter.register(ActiveShikiHighlighter, 'shiki')
  shared.adapterState = 'active'
}

function disposeShikiRuntime() {
  shared.highlighter?.dispose()
  shared.highlighter = null
  shared.key = null
  if (shared.adapterState === 'absent') return
  SyntaxHighlighter.register(InactiveShikiHighlighter, 'shiki')
  shared.adapterState = 'inactive'
}

export function afterPluginsLoaded(locators = []) {
  if (!locators.includes('mkadoc:shiki')) {
    disposeShikiRuntime()
  }
}

/** @type {import('../plugin/contract.js').MkadocPluginFactory} */
export default function shikiPlugin(rawOptions = {}) {
  const {
    theme,
    langs,
    css_href: cssHref,
  } = parsePluginOptions('mkadoc:shiki', OptionsSchema, rawOptions)

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

      const cssAsset = resolveSiteAsset(host.root, host.config.output, cssHref)
      const assetDir = path.posix.dirname(cssAsset.relPath)
      const out = host.config.output.replace(/\\/g, '/').replace(/\/$/, '')
      host.registerAssetPrefix(assetDir === '.' ? out : path.posix.join(out, assetDir))

      if (!shared.highlighter) {
        throw new Error('mkadoc:shiki: highlighter not initialized (setup failed)')
      }

      ensureActiveAdapter()

      shared.theme = theme

      host.addAttributes({
        'source-highlighter': 'shiki',
        'shiki-theme': theme,
      })
    },

    async contributeChrome(host) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, cssHref)
      const css = `/* Generated from Shiki theme: ${theme} — do not edit. */
.listingblock > .content > pre.shiki,
.listingblock > .content > pre.shiki code {
  background: ${shared.colors.bg};
  color: ${shared.colors.fg};
}
`
      writeIfChanged(cssAsset.absPath, css)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
      })
    },
  }
}
