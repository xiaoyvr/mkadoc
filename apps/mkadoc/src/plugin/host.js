import fs from 'node:fs'
import path from 'node:path'
import { Extensions } from '@asciidoctor/core'
import { CACHE_DIR } from '../config.js'
import { registerIncludeCollector } from '../deps.js'
import { relToRoot, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'

/**
 * Shared mutable state behind the plugin and build hosts.
 * @param {import('../config.js').MkadocConfig} cfg
 */
function createHostState(cfg, deps = null) {
  return {
    cfg,
    deps,
    registry: Extensions.create(),
    attributes: {},
    headLinks: [],
    headScripts: [],
    classifiers: [],
    assetPrefixes: [],
    /** @type {string[]} */
    chromeBody: [],
    headerProvided: false,
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

    registerExtension(registerFn) {
      registerFn(state.registry)
    },

    addAttributes(attrs) {
      Object.assign(state.attributes, attrs)
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

  function headerDocinfoPath() {
    return path.join(cfg.root, cfg.docinfoDir, 'docinfo-header.html')
  }

  return Object.freeze({
    get config() {
      return cfg
    },
    get root() {
      return cfg.root
    },
    get registry() {
      return state.registry
    },
    get attributes() {
      return state.attributes
    },
    get assetPrefixes() {
      return state.assetPrefixes
    },
    get chromeBody() {
      return state.chromeBody
    },

    contributeHead({ links = [], scripts = [] } = {}) {
      state.headLinks.push(...links)
      state.headScripts.push(...scripts)
    },

    headerDocinfoPath,

    headerDocinfoExists() {
      return fs.existsSync(headerDocinfoPath())
    },

    markHeaderProvided() {
      state.headerProvided = true
    },

    async writeHeaderDocinfo(html) {
      writeIfChanged(headerDocinfoPath(), html)
      state.headerProvided = true
    },

    writeHeadDocinfo() {
      const lines = []
      for (const link of state.headLinks) {
        const attrs = Object.entries(link)
          .map(([k, v]) => (v === true ? k : `${k}="${escapeHtmlAttr(v)}"`))
          .join(' ')
        lines.push(`<link ${attrs}>`)
      }
      for (const script of state.headScripts) {
        const { src, defer, async: isAsync, ...rest } = script
        const parts = [`src="${escapeHtmlAttr(src)}"`]
        if (defer) parts.push('defer')
        if (isAsync) parts.push('async')
        for (const [k, v] of Object.entries(rest)) {
          parts.push(v === true ? k : `${k}="${escapeHtmlAttr(v)}"`)
        }
        lines.push(`<script ${parts.join(' ')}></script>`)
      }
      const out = path.join(cfg.root, cfg.docinfoDir, 'docinfo.html')
      const body = lines.join('\n') + (lines.length ? '\n' : '')
      return writeIfChanged(out, body)
    },

    wantsDocinfo() {
      return state.headerProvided || state.headLinks.length > 0 || state.headScripts.length > 0
    },

    classifyPath(p) {
      for (const fn of state.classifiers) {
        const result = fn(p)
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
  // Core-owned include tracker (feeds the dependency graph during page convert).
  registerIncludeCollector(state.registry)
  return {
    plugin: createPluginHost(state),
    build: createBuildHost(state),
  }
}
