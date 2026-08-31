import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from '../config.js'
import { relToRoot } from '../fs-utils.js'
import { createSession } from '../session.js'

/**
 * Marker on the object returned by `host.plugin(deps, create)`. The loader
 * detects declarations (vs. plain plugin objects) via this symbol and calls
 * `create` with resolved dependencies.
 */
export const DECLARATION = Symbol('mkadoc.plugin.declaration')

/** Parse a dependency list: `'name'` (required) or `'name?'` (optional). */
export function normalizeDeps(deps) {
  if (!Array.isArray(deps)) {
    throw new Error(`mkadoc: plugin dependencies must be an array of names (got ${typeof deps})`)
  }
  return deps.map((raw) => {
    const text = String(raw)
    if (!text) throw new Error('mkadoc: empty dependency name in plugin dependency list')
    const optional = text.endsWith('?')
    const name = optional ? text.slice(0, -1) : text
    if (!name) throw new Error('mkadoc: empty dependency name in plugin dependency list')
    return { name, optional }
  })
}

/**
 * Shared mutable state behind the plugin and build hosts.
 * Core is renderer-agnostic: it holds no markup-specific concepts — renderers
 * own their conversion state; feature plugins share capabilities via the
 * dependency registry (load-time values) and services (runtime values).
 * @param {import('../config.js').MkadocConfig} cfg
 * @param {ReturnType<typeof createSession>} session
 */
function createHostState(cfg, deps, session) {
  return {
    cfg,
    deps,
    /** The explicit session-scoped container (registry + cross-build state). */
    session,
    /**
     * Plugin lifecycle phase. Gates the DI surface:
     * - `loading` — factories run; `provide`/`plugin` are callable,
     *   `getService` throws (registry/services incomplete)
     * - `resolving` — declarations collected; `provide`/`plugin` throw (too
     *   late — the graph is fixed), `getService` still throws
     * - `ready` — all plugins created + set up; `getService` resolvable
     * - `disposed` — everything throws
     */
    phase: 'loading',
    /** Dependency registry: core whitelist + plugin-provided capabilities. */
    registry: session.registry,
    /** @type {{ owner: string, deps: { name: string, optional: boolean }[], create: (deps: Record<string, unknown>) => unknown }[]} */
    declarations: [],
    /** Locator of the plugin whose factory is currently running. */
    currentOwner: null,
    headLinks: [],
    headScripts: [],
    classifiers: [],
    assetPrefixes: [],
    /** @type {string[]} */
    chromeBody: [],
    /** @type {Map<string, unknown>} runtime services (provideService/getService) */
    services: new Map(),
    /** @type {import('@mkadoc/plugin-host').MkadocRenderer[]} */
    renderers: [],
  }
}

/**
 * @param {ReturnType<typeof createHostState>} state
 * @returns {import('@mkadoc/plugin-host').MkadocPluginHost}
 */
function createPluginHost(state) {
  const { cfg } = state

  function ensureDir(relOrAbs) {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cfg.root, relOrAbs)
    fs.mkdirSync(abs, { recursive: true })
    return abs
  }

  function requireLoadingPhase(method) {
    if (state.phase !== 'loading') {
      throw new Error(
        `mkadoc: ${method} is only callable from the plugin factory (load phase) — it was called during "${state.phase}". Declarations must be fixed before dependencies resolve.`,
      )
    }
  }

  return Object.freeze({
    get config() {
      return cfg
    },
    get root() {
      return cfg.root
    },

    get renderers() {
      return state.renderers
    },

    /** @param {import('@mkadoc/plugin-host').MkadocRenderer} renderer */
    registerRenderer(renderer) {
      state.renderers.push(renderer)
    },

    /**
     * Publish a load-time capability. Declaration only: `provider` is a
     * factory (optionally async) that the container runs when a consumer
     * depends on `name` — never during load order. Factory-phase only.
     *
     * `opts.key` is the session cache identity: re-providing with the same
     * key across rebuilds (serve) retains the memoized value, so expensive
     * construction (e.g. shiki's highlighter) happens once per session.
     * `opts.onRelease` runs when the value is replaced or the provider is
     * removed from config.
     * @param {string} name
     * @param {() => unknown} provider
     * @param {{ key?: string | null, onRelease?: (() => void) | null }} [opts]
     */
    provide(name, provider, opts) {
      requireLoadingPhase('provide()')
      state.registry.provide(name, provider, state.currentOwner ?? 'a plugin', opts)
    },

    /**
     * Declare this plugin's dependencies and its body. `deps` is a list of
     * registry names; a trailing `?` marks the dependency optional (resolved
     * to `undefined` when no provider is loaded). The loader resolves every
     * dependency after all plugins have declared, then calls `create(deps)` in
     * config order — so the returned object is the plugin, and chrome order
     * (config order) is preserved regardless of dependency order.
     *
     * `create` receives the resolved values positionally, in declared order,
     * and may close over them; the factory itself cannot use them (options
     * parsing stays in the factory).
     * @param {string[]} deps
     * @param {(deps: unknown[]) => import('@mkadoc/plugin-host').MkadocPlugin | Promise<import('@mkadoc/plugin-host').MkadocPlugin>} create
     */
    plugin(deps, create) {
      requireLoadingPhase('plugin()')
      if (typeof create !== 'function') {
        throw new Error(
          `mkadoc: host.plugin(deps, create) needs a create function (got ${typeof create})`,
        )
      }
      const declaration = {
        owner: state.currentOwner ?? 'a plugin',
        deps: normalizeDeps(deps),
        create,
      }
      state.declarations.push(declaration)
      return { [DECLARATION]: declaration }
    },

    /** @internal used by the loader to name provide()/plugin() calls */
    setOwner(owner) {
      state.currentOwner = owner
    },

    /** @internal loader accessors into the registry (declaration resolution) */
    hasDep(name) {
      return state.registry.has(name)
    },
    resolveDep(name) {
      return state.registry.resolve(name)
    },

    /** @internal bracket one plugin load (generation + reentrancy guard) */
    beginLoad() {
      state.registry.beginLoad()
    },
    endLoad() {
      state.registry.endLoad()
    },

    /**
     * Core-internal session access (builtins only, not a plugin contract
     * surface). Lets built-ins reach session-scoped state from hooks.
     * @internal
     */
    get session() {
      return state.session
    },

    /**
     * Resolve a capability registered by another plugin at runtime.
     *
     * Runtime escape hatch: only for values that do not exist at load time
     * (e.g. `mkadoc:nav` publishes `site-root` at chrome time, derived from
     * build output). Load-time-stable capabilities should be injected via
     * `host.plugin(['name'], ...)` instead.
     *
     * Only callable after every plugin finished setup — during load the
     * registry is incomplete (providers run in config order), so a lookup
     * could only ever be order-dependent or miss a provider that hasn't run
     * yet. The loader flips the phase to `ready` before returning the runner;
     * `dispose` flips it to `disposed`.
     * @param {string} name
     * @returns {unknown}
     */
    getService(name) {
      if (state.phase === 'loading' || state.phase === 'resolving') {
        throw new Error(
          `mkadoc: getService('${name}') during plugin ${state.phase === 'resolving' ? 'creation' : 'load'} — services are only resolvable after every plugin finished setup. Inject the value instead: host.plugin(['${name}'], (value) => ...), or defer the lookup to render time / contributeChrome / check.`,
        )
      }
      if (state.phase === 'disposed') {
        throw new Error(
          `mkadoc: getService('${name}') after plugins were disposed — services are no longer available`,
        )
      }
      return state.services.get(name)
    },

    /**
     * Publish a runtime value (see `getService`). Unlike `provide`, this is
     * not part of the dependency graph — use it only for values that cannot
     * exist at load time.
     * @param {string} name
     * @param {unknown} service
     */
    provideService(name, service) {
      state.services.set(name, service)
    },

    /**
     * Advance the plugin lifecycle phase. Loader-internal — plugins must not
     * call this; the loading-phase gate exists precisely to stop load-time
     * service reads (plugins are trusted, so this is a convention, not a
     * sandbox).
     * @internal
     * @param {'loading' | 'resolving' | 'ready' | 'disposed'} phase
     */
    setPhase(phase) {
      state.phase = phase
    },

    contributeHead({ links = [], scripts = [] } = {}) {
      state.headLinks.push(...links)
      state.headScripts.push(...scripts)
    },

    contributeChromeBody(html) {
      const chunk = String(html || '').trim()
      if (chunk) state.chromeBody.push(chunk)
    },

    registerClassifier(fn) {
      state.classifiers.push(fn)
    },

    registerSiteWideDep(relPath) {
      if (!state.deps) {
        throw new Error('mkadoc: registerSiteWideDep requires a dependency graph')
      }
      state.deps.addSiteWide(relPath)
    },

    registerAssetPrefix(prefix) {
      const norm = `${prefix.replace(/\/$/, '')}/`
      if (!state.assetPrefixes.includes(norm)) state.assetPrefixes.push(norm)
    },

    ensureDir,

    cacheDir(name) {
      return ensureDir(path.join(CACHE_DIR, name))
    },

    relToRoot(p) {
      return relToRoot(p, cfg.root)
    },

    /**
     * Resolve a module from mkadoc's core whitelist (single shared instance,
     * anchored at mkadoc). Only names on the whitelist resolve; anything else
     * is either a plugin capability (use `host.plugin([...])` to inject it) or
     * unavailable by design. Useful for factory-time needs (e.g. option
     * parsing) that run before dependencies resolve.
     * @param {string} specifier
     * @returns {Promise<Record<string, unknown>>}
     */
    async import(specifier) {
      if (!state.registry.isCore(specifier)) {
        const known = state.registry.names().join(', ')
        throw new Error(
          `mkadoc: host.import('${specifier}') failed: "${specifier}" is not on mkadoc's core module whitelist (${known || 'none'}). Plugin-provided capabilities resolve via host.plugin(['${specifier}'], ...); other modules are not exposed to plugins.`,
        )
      }
      return state.registry.resolve(specifier)
    },
  })
}

/**
 * @param {ReturnType<typeof createHostState>} state
 * @returns {import('@mkadoc/plugin-host').MkadocBuildHost}
 */
function createBuildHost(state) {
  const { cfg } = state

  /** @param {string} p */
  function rendererForPath(p) {
    const ext = path.extname(String(p)).toLowerCase()
    if (!ext) return null
    for (const renderer of state.renderers) {
      if (renderer.extensions?.includes(ext)) return renderer
    }
    return null
  }

  return Object.freeze({
    get config() {
      return cfg
    },
    get root() {
      return cfg.root
    },
    get headLinks() {
      return state.headLinks
    },
    get headScripts() {
      return state.headScripts
    },
    get chromeBody() {
      return state.chromeBody
    },
    get assetPrefixes() {
      return state.assetPrefixes
    },
    get renderers() {
      return state.renderers
    },

    rendererForPath,

    async classifyPath(p) {
      for (const fn of state.classifiers) {
        const result = await fn(p)
        if (result === 'full') return 'full'
      }
      return null
    },
  })
}

/**
 * Create paired hosts sharing one build state.
 * Pass `plugin` into plugins; keep `build` for core orchestration.
 *
 * @param {import('../config.js').MkadocConfig} cfg
 * @param {ReturnType<typeof createSession>} session
 * @param {{ deps?: import('../deps.js').DependencyGraph | null, session?: ReturnType<typeof createSession> }} [opts]
 * @returns {{ plugin: import('@mkadoc/plugin-host').MkadocPluginHost, build: import('@mkadoc/plugin-host').MkadocBuildHost }}
 */
export function createHosts(cfg, { deps = null, session = createSession() } = {}) {
  const state = createHostState(cfg, deps, session)
  return {
    plugin: createPluginHost(state),
    build: createBuildHost(state),
  }
}
