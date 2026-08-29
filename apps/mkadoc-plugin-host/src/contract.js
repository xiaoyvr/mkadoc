/**
 * Plugin authoring contract (`mkadoc:*` builtins and external plugins).
 * Factories annotate with `@type {import('@mkadoc/plugin-host').MkadocPluginFactory}`.
 *
 * Plugins receive {@link MkadocPluginHost} only.
 * Core (`build.js`, `chrome.js`, `decide-mode.js`) uses {@link MkadocBuildHost}.
 *
 * @typedef {'full' | 'incremental' | 'assets' | 'noop'} BuildMode
 *
 * @typedef {object} MkadocSource
 * @property {string} path        repo-relative source dir (posix)
 * @property {string} mount       site mount, e.g. `/` or `/apps/mkadoc`
 * @property {string} title       source bar / section label
 * @property {string} description `:description:` / frontmatter description (brand for first source)
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {MkadocSource[]} sources
 * @property {string} output
 * @property {Record<string, Record<string, unknown>>} plugins
 * @property {{ remote: boolean, port: number }} serve
 *
 * @typedef {{ mode: BuildMode, pages: string[], paths?: string[] }} BuildContext
 *
 * @typedef {{ ok: boolean, message?: string }} CheckResult
 *
 * @typedef {object} MkadocPluginHost
 * @property {MkadocConfig} config
 * @property {string} root
 * @property {(attrs: Record<string, unknown>) => void} addAttributes
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(html: string) => void} contributeChromeBody append below-topbar chrome HTML
 * @property {(fn: (p: string) => 'full' | null | undefined) => void} registerClassifier
 * @property {(relPath: string) => void} registerSiteWideDep mark path as rebuilding every page
 * @property {(prefix: string) => void} registerAssetPrefix
 * @property {(name: string, service: unknown) => void} provideService publish a capability
 * @property {(name: string) => unknown} getService resolve a capability (or undefined)
 * @property {(relOrAbs: string) => string} ensureDir
 * @property {(name: string) => string} cacheDir
 * @property {(p: string) => string} relToRoot
 * @property {(specifier: string) => Promise<Record<string, unknown>>} import resolve a module
 *   from mkadoc's own dependencies (single shared instance; e.g. `host.import('zod')`)
 *
 * @typedef {object} MkadocBuildHost
 * @property {MkadocConfig} config
 * @property {string} root
 * @property {Record<string, unknown>} attributes
 * @property {string[]} assetPrefixes
 * @property {string[]} chromeBody
 * @property {MkadocRenderer[]} renderers
 * @property {(p: string) => MkadocRenderer | null} rendererForPath
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(p: string) => 'full' | null} classifyPath
 *
 * @typedef {object} RenderInput
 * @property {string} sourceText
 * @property {string} absPath       absolute source file path
 * @property {string} baseDir       absolute source dir
 * @property {Record<string, unknown>} attributes merged plugin attributes
 *
 * @typedef {object} RenderOutput
 * @property {string} html           article body (inside <body>, after chrome)
 * @property {string} title          <head><title>
 * @property {string} [lang]         <html lang>; default `en`
 * @property {string} [bodyClass]    <body class>
 * @property {string} [head]         extra renderer-owned <head> content
 * @property {string[]} [assets]     repo-relative referenced files to copy
 * @property {string[]} [includes]   repo-relative files this page depends on
 *
 * @typedef {{ title: string, description: string, tab?: string }} SourceMeta
 *
 * @typedef {object} MkadocRenderer
 * @property {string} name
 * @property {'renderer'} kind
 * @property {string[]} extensions
 * @property {(sourceText: string, absPath: string) => SourceMeta | Promise<SourceMeta>} extractMeta
 * @property {(input: RenderInput) => RenderOutput | Promise<RenderOutput>} render
 * @property {(input: RenderInput) => string | Promise<string>} renderFragment
 * @property {(host: MkadocPluginHost) => CheckResult | Promise<CheckResult>} [check]
 *
 * @typedef {object} MkadocPlugin
 * @property {string} name
 * @property {'feature' | 'renderer'} [kind] default `feature`
 * @property {string} [locator] set by the loader
 * @property {(host: MkadocPluginHost) => void | Promise<void>} [setup]
 * @property {(host: MkadocPluginHost, ctx: BuildContext) => void | Promise<void>} [contributeChrome]
 * @property {(host: MkadocPluginHost) => CheckResult | Promise<CheckResult>} [check]
 *
 * @typedef {(options?: Record<string, unknown>, host?: MkadocPluginHost) => MkadocPlugin | Promise<MkadocPlugin>} MkadocPluginFactory
 */

export {}
