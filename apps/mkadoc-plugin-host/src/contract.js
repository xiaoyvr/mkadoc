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
 * @property {string} mount       site mount, derived verbatim from the source path (e.g.
 *                                `/apps/mkadoc/docs`); never `/` — root mounts are not configurable
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {MkadocSource[]} sources
 * @property {string} output
 * @property {{ brand: string }} site
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
 * @property {(contrib?: { links?: object[], scripts?: object[] }) => void} contributeHead
 * @property {(html: string) => void} contributeChromeBody append below-topbar chrome HTML
 * @property {(fn: (p: string) => 'full' | null | undefined) => void} registerClassifier
 * @property {(relPath: string) => void} registerSiteWideDep mark path as rebuilding every page
 * @property {(prefix: string) => void} registerAssetPrefix
 * @property {(name: string, provider: () => unknown | Promise<unknown>, opts?: { key?: string, onRelease?: () => void }) => void} provide publish a
 *   load-time capability; declaration only — the container runs `provider` (once per session, lazily)
 *   when a consumer depends on `name`. Factory-phase only (throws afterwards). `opts.key` retains
 *   the memoized value across rebuilds while unchanged (expensive construction runs once per serve
 *   session); `opts.onRelease` runs when the value is replaced or the provider leaves config.
 *   Core seeds some capabilities of its own (`site-root` — a command function plugins call to set
 *   where `/` redirects); they resolve exactly like plugin-provided ones and cannot be shadowed.
 * @property {(deps: string[], create: (deps: unknown[]) => MkadocPlugin | Promise<MkadocPlugin>) => MkadocPluginDeclaration} plugin declare
 *   dependencies (names from the registry; trailing `?` = optional, resolved to `undefined`) and the
 *   plugin body. The loader resolves every dependency after all plugins declare, then calls `create`
 *   with the values **positionally, in declared order**, in config order. Factory-phase only. `create`
 *   may close over the resolved values.
 * @property {(relOrAbs: string) => string} ensureDir
 * @property {(name: string) => string} cacheDir
 * @property {(p: string) => string} relToRoot
 * @property {object} [session] **core-internal** session-scoped state (builtins only; not a plugin
 *   contract surface). Slots: `registry` (DI container incl. core capabilities), `nav` (classifier
 *   state), `plugin` (disposal bookkeeping), `build` (per-build results — written only via the
 *   core-provided `site-root` capability, never by plugins directly).
 * @property {(specifier: string) => Promise<Record<string, unknown>>} import resolve a module from
 *   mkadoc's core whitelist (single shared instance; factory-time needs like option parsing — e.g.
 *   `host.import('zod')`). Plugin-provided capabilities resolve via `host.plugin([...])` instead.
 *
 * @typedef {object} MkadocPluginDeclaration
 * @property {symbol} [__mkadocDeclaration] marker — the object returned by `host.plugin(...)`;
 *   the loader recognizes it and calls `create` with resolved dependencies
 * @property {string} owner locator of the declaring plugin (set by the loader)
 * @property {{ name: string, optional: boolean }[]} deps normalized dependency list
 * @property {(deps: unknown[]) => MkadocPlugin | Promise<MkadocPlugin>} create
 *
 *
 * @typedef {object} MkadocBuildHost
 * @property {MkadocConfig} config
 * @property {string} root
 * @property {string[]} assetPrefixes
 * @property {string[]} chromeBody
 * @property {MkadocRenderer[]} renderers
 * @property {(p: string) => MkadocRenderer | null} rendererForPath
 * @property {(p: string) => 'full' | null} classifyPath
 *
 * @typedef {object} RenderInput
 * @property {string} sourceText
 * @property {string} absPath       absolute source file path
 * @property {string} baseDir       absolute source dir
 * @property {string} [linkPrefix] prefix for relative links in fragments (nav's `_nav.adoc` mounted at a non-root path)
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
 * @typedef {{ title: string, navLabel?: string }} SourceMeta
 *
 * @typedef {object} MkadocRenderer
 * @property {string} name
 * @property {'renderer'} kind
 * @property {string[]} extensions
 * @property {(sourceText: string, absPath: string) => SourceMeta | Promise<SourceMeta>} extractMeta
 * @property {(input: RenderInput) => RenderOutput | Promise<RenderOutput>} render
 * @property {(input: RenderInput) => string | Promise<string>} renderFragment
 * @property {(input: RenderInput) => { href: string, label: string } | Promise<{ href: string, label: string }>} [extractFirstLink] parse a nav fragment for its first link
 * @property {(host: MkadocPluginHost) => CheckResult | Promise<CheckResult>} [check]
 *
 * @typedef {object} MkadocPlugin
 * @property {string} name
 * @property {'feature' | 'renderer'} [kind] default `feature`
 * @property {string} [locator] set by the loader
 * @property {(host: MkadocPluginHost) => void | Promise<void>} [setup]
 * @property {(host: MkadocPluginHost, ctx: BuildContext) => void | Promise<void>} [contributeChrome]
 * @property {(host: MkadocPluginHost) => CheckResult | Promise<CheckResult>} [check]
 * @property {(host: MkadocPluginHost) => void | Promise<void>} [dispose] release resources when the plugin is unloaded (config change under serve)
 *
 * @typedef {(options?: Record<string, unknown>, host?: MkadocPluginHost) => MkadocPluginDeclaration | Promise<MkadocPluginDeclaration>} MkadocPluginFactory
 */

export {}
