import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from '../config.js'
import { relToRoot } from '../fs-utils.js'

/**
 * Shared mutable state behind the plugin and build hosts.
 * Core is renderer-agnostic: it holds no markup-specific concepts — renderers
 * own their conversion state; feature plugins share capabilities via services.
 * @param {import('../config.js').MkadocConfig} cfg
 */
function createHostState(cfg, deps = null) {
  return {
    cfg,
    deps,
    /** Plugin lifecycle phase — gates `getService` (see `createPluginHost`). */
    phase: 'loading',
    headLinks: [],
    headScripts: [],
    classifiers: [],
    assetPrefixes: [],
    /** @type {string[]} */
    chromeBody: [],
    /** @type {Map<string, unknown>} */
    services: new Map(),
    /** @type {import('./contract.js').MkadocRenderer[]} */
    renderers: [],
  }
}

/**
 * @param {ReturnType<typeof createHostState>} state
 * @returns {import('./contract.js').MkadocPluginHost}
 */
function createPluginHost(state) {
  const { cfg } = state

  function ensureDir(relOrAbs) {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cfg.root, relOrAbs)
    fs.mkdirSync(abs, { recursive: true })
    return abs
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

    /** @param {import('./contract.js').MkadocRenderer} renderer */
    registerRenderer(renderer) {
      state.renderers.push(renderer)
    },

    provideService(name, service) {
      state.services.set(name, service)
    },

    /**
     * Resolve a capability registered by another plugin.
     *
     * Only callable after every plugin finished `setup` — during load the
     * registry is incomplete (providers run in config order), so a lookup
     * could only ever be order-dependent or miss a provider that hasn't run
     * yet. The loader flips the phase to `ready` before returning the runner;
     * `dispose` flips it to `disposed`.
     * @param {string} name
     * @returns {unknown}
     */
    getService(name) {
      if (state.phase === 'loading') {
        throw new Error(
          `mkadoc: getService('${name}') during plugin load — services are only resolvable after every plugin finished setup. Defer the lookup to render time (or contributeChrome/check), or declare a hard dependency with requires: ['${name}'] on the plugin.`,
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
     * Advance the plugin lifecycle phase. Loader-internal — plugins must not
     * call this; the loading-phase gate exists precisely to stop load-time
     * service reads (plugins are trusted, so this is a convention, not a
     * sandbox).
     * @internal
     * @param {'loading' | 'ready' | 'disposed'} phase
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
     * Resolve + import a module from mkadoc's own dependencies.
     * Anchored at this module, so the same single instance is shared with core.
     * @param {string} specifier
     * @returns {Promise<Record<string, unknown>>}
     */
    async import(specifier) {
      let resolved
      try {
        resolved = await import.meta.resolve(specifier, import.meta.url)
      } catch (err) {
        throw new Error(
          `mkadoc: host.import('${specifier}') failed: not resolvable from mkadoc's dependencies (${err?.message || err})`,
        )
      }
      return import(resolved)
    },
  })
}

/**
 * @param {ReturnType<typeof createHostState>} state
 * @returns {import('./contract.js').MkadocBuildHost}
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

    contributeHead({ links = [], scripts = [] } = {}) {
      state.headLinks.push(...links)
      state.headScripts.push(...scripts)
    },

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
 * @param {{ deps?: import('../deps.js').DependencyGraph | null }} [opts]
 * @returns {{ plugin: import('./contract.js').MkadocPluginHost, build: import('./contract.js').MkadocBuildHost }}
 */
export function createHosts(cfg, { deps = null } = {}) {
  const state = createHostState(cfg, deps)
  return {
    plugin: createPluginHost(state),
    build: createBuildHost(state),
  }
}
