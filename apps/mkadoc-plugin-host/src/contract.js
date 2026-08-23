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
 * @property {string} description `:description:` from index.adoc (brand for first source)
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {MkadocSource[]} sources
 * @property {string} output
 * @property {string} docinfoDir
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
 * @property {(registerFn: (registry: unknown) => void) => void} registerExtension
 * @property {(attrs: Record<string, unknown>) => void} addAttributes
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(html: string) => void} contributeChromeBody append below-topbar chrome HTML
 * @property {(fn: (p: string) => 'full' | null | undefined) => void} registerClassifier
 * @property {(relPath: string) => void} registerSiteWideDep mark path as rebuilding every page
 * @property {(prefix: string) => void} registerAssetPrefix
 * @property {(relOrAbs: string) => string} ensureDir
 * @property {(name: string) => string} cacheDir
 * @property {(p: string) => string} relToRoot
 * @property {(specifier: string) => Promise<Record<string, unknown>>} import resolve a module
 *   from mkadoc's own dependencies (single shared instance; e.g. `host.import('zod')`)
 *
 * @typedef {object} MkadocBuildHost
 * @property {MkadocConfig} config
 * @property {string} root
 * @property {unknown} registry
 * @property {Record<string, unknown>} attributes
 * @property {string[]} assetPrefixes
 * @property {string[]} chromeBody
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {() => string} headerDocinfoPath
 * @property {() => boolean} headerDocinfoExists
 * @property {() => void} markHeaderProvided
 * @property {(html: string) => Promise<void>} writeHeaderDocinfo
 * @property {() => boolean} writeHeadDocinfo
 * @property {() => boolean} wantsDocinfo
 * @property {(p: string) => 'full' | null} classifyPath
 *
 * @typedef {object} MkadocPlugin
 * @property {string} name
 * @property {string} [locator] set by the loader
 * @property {(host: MkadocPluginHost) => void | Promise<void>} [setup]
 * @property {(host: MkadocPluginHost, ctx: BuildContext) => void | Promise<void>} [contributeChrome]
 * @property {(host: MkadocPluginHost) => CheckResult | Promise<CheckResult>} [check]
 *
 * @typedef {(options?: Record<string, unknown>, host?: MkadocPluginHost) => MkadocPlugin | Promise<MkadocPlugin>} MkadocPluginFactory
 */

export {}
