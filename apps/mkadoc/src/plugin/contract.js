/**
 * Plugin contract for mkadoc builtins (`mkadoc:*` only).
 *
 * Lifecycle:
 * 1. **Load** — `createHost(cfg)` then `loadPlugins(...)`.
 *    For each enabled plugin (config key order): factory(options) → `setup(host)`.
 *    `setup` may register classifiers, asset prefixes, cache dirs, Asciidoctor
 *    extensions, and document attributes.
 * 2. **Per build** — after `decideMode`, core calls `contributeChrome(host, ctx)`
 *    on each plugin (same order). Plugins may write header/CSS/JS and call
 *    `contributeHead`. Then core writes head docinfo, copies assets when needed,
 *    and converts pages.
 * 3. **Check** — `mkadoc check` calls optional `check(host)` on each plugin.
 *
 * There is no third-party / path-based plugin loading.
 *
 * Options: each plugin owns defaults and validates its option keys (see
 * `resolvePluginOptions` in `options.js`). Core config only allowlists locators
 * (`locators.js`); plugin option fields are opaque to Zod.
 *
 * @typedef {'full' | 'incremental' | 'assets'} BuildMode
 *
 * @typedef {{ mode: BuildMode, pages: string[] }} BuildContext
 *
 * @typedef {{ ok: boolean, message?: string }} CheckResult
 *
 * @typedef {object} MkadocHost
 * @property {import('../config.js').MkadocConfig} config
 * @property {string} root
 * @property {unknown} registry
 * @property {Record<string, unknown>} attributes
 * @property {string[]} assetPrefixes
 * @property {(registerFn: (registry: unknown) => void) => void} registerExtension
 * @property {(attrs: Record<string, unknown>) => void} addAttributes
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(fn: (p: string) => 'full' | null | undefined) => void} registerClassifier
 * @property {(prefix: string) => void} registerAssetPrefix
 * @property {(relOrAbs: string) => string} ensureDir
 * @property {(name: string) => string} cacheDir
 * @property {(p: string) => string} relToRoot
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
 * @property {(host: MkadocHost) => void | Promise<void>} [setup]
 * @property {(host: MkadocHost, ctx: BuildContext) => void | Promise<void>} [contributeChrome]
 * @property {(host: MkadocHost) => CheckResult | Promise<CheckResult>} [check]
 *
 * @typedef {(options?: Record<string, unknown>) => MkadocPlugin} MkadocPluginFactory
 */

export {}
