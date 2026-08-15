/**
 * Plugin authoring contract (`mkadoc:*` builtins).
 * Factories annotate with `@type {import('./contract.js').MkadocPluginFactory}`.
 *
 * Plugins receive {@link MkadocPluginHost} only.
 * Core (`build.js`, `chrome.js`, `decide-mode.js`) uses {@link MkadocBuildHost}.
 *
 * @typedef {'full' | 'incremental' | 'assets'} BuildMode
 *
 * @typedef {{ mode: BuildMode, pages: string[], paths?: string[] }} BuildContext
 *
 * @typedef {{ ok: boolean, message?: string }} CheckResult
 *
 * @typedef {object} MkadocPluginHost
 * @property {import('../config.js').MkadocConfig} config
 * @property {string} root
 * @property {(registerFn: (registry: unknown) => void) => void} registerExtension
 * @property {(attrs: Record<string, unknown>) => void} addAttributes
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(html: string) => void} contributeChromeBody append below-topbar chrome HTML
 * @property {(fn: (p: string) => 'full' | null | undefined) => void} registerClassifier
 * @property {(prefix: string) => void} registerAssetPrefix
 * @property {(relOrAbs: string) => string} ensureDir
 * @property {(name: string) => string} cacheDir
 * @property {(p: string) => string} relToRoot
 *
 * @typedef {object} MkadocBuildHost
 * @property {import('../config.js').MkadocConfig} config
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
 * @typedef {(options?: Record<string, unknown>) => MkadocPlugin} MkadocPluginFactory
 */

export {}
