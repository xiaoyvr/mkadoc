import path from 'node:path'
import { SyntaxHighlighter, SyntaxHighlighterBase } from '@asciidoctor/core'
import { createHighlighter } from 'shiki'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { resolvePluginOptions } from '../plugin/options.js'

const DEFAULTS = {
  theme: 'github-light-default',
  langs: [
    'bash',
    'shellscript',
    'nix',
    'javascript',
    'json',
    'yaml',
    'ruby',
    'python',
    'plaintext',
  ],
  css_href: '/styles/shiki.css',
}

const DEFAULT_THEME = DEFAULTS.theme

const LANG_ALIASES = {
  sh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  js: 'javascript',
}

/**
 * Process-global runtime for the Asciidoctor `shiki` adapter.
 * Adapter registration cannot be removed from Asciidoctor’s factory, so we
 * swap between an active adapter and an inactive stub that fails clearly.
 */
const shared = {
  /** @type {import('shiki').Highlighter | null} */
  highlighter: null,
  /** @type {string | null} */
  key: null,
  theme: DEFAULT_THEME,
  /** @type {{ bg: string, fg: string }} */
  colors: { bg: '#ffffff', fg: '#1f2328' },
  /** @type {'absent' | 'active' | 'inactive'} */
  adapterState: 'absent',
}

function langListFor(langs) {
  const langList = new Set([...langs, 'plaintext'])
  for (const alias of Object.values(LANG_ALIASES)) langList.add(alias)
  return [...langList].sort()
}

class ActiveShikiHighlighter extends SyntaxHighlighterBase {
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
  /**
   * @param {string} name
   * @param {string} [backend]
   * @param {object} [opts]
   */
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
  // Asciidoctor 4: register(adapter, ...names) — process-global; overwrites prior entry.
  SyntaxHighlighter.register(ActiveShikiHighlighter, 'shiki')
  shared.adapterState = 'active'
}

/**
 * Dispose the Highlighter and park an inactive adapter under the `shiki` name.
 * Safe to call when Shiki was never enabled.
 */
export function disposeShikiRuntime() {
  shared.highlighter?.dispose()
  shared.highlighter = null
  shared.key = null
  if (shared.adapterState === 'absent') return
  SyntaxHighlighter.register(InactiveShikiHighlighter, 'shiki')
  shared.adapterState = 'inactive'
}

/**
 * Called after builtins are loaded so a config reload that drops `mkadoc:shiki`
 * does not leave a live Highlighter (or active adapter) in the serve process.
 * @param {string[]} locators
 */
export function afterPluginsLoaded(locators = []) {
  if (!locators.includes('mkadoc:shiki')) {
    disposeShikiRuntime()
  }
}

/**
 * Test/introspection snapshot of the process-global runtime.
 */
export function getShikiRuntimeSnapshot() {
  return {
    adapterState: shared.adapterState,
    hasHighlighter: Boolean(shared.highlighter),
    key: shared.key,
    theme: shared.theme,
    colors: { ...shared.colors },
  }
}

/**
 * Build-time Shiki highlighter (same registration model as tani/asciidoctor-shiki).
 *
 * Theme background/foreground are taken from the loaded Shiki theme (not hardcoded)
 * and written to site/styles/shiki.css so listing blocks match the token colors.
 *
 * @param {Record<string, unknown>} [rawOptions]
 * @returns {import('../plugin/contract.js').MkadocPlugin}
 */
export default function shikiPlugin(rawOptions = {}) {
  const options = resolvePluginOptions('mkadoc:shiki', rawOptions, DEFAULTS)
  const theme = options.theme
  const langs =
    Array.isArray(options.langs) && options.langs.length ? options.langs : DEFAULTS.langs
  const cssHref = options.css_href

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

      // Keep adapter defaults in sync when theme changes without re-registering.
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
