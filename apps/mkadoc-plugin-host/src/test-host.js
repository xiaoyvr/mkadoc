import fs from 'node:fs'
import path from 'node:path'

/**
 * In-memory / on-disk test double for {@link import('./contract.js').MkadocPluginHost}.
 * Records hook calls into `host._test` for assertions; `import` serves from a
 * caller-provided module map (e.g. `{ zod: { z } }`).
 *
 * DI test double semantics: `host.plugin(deps, create)` resolves deps *eagerly*
 * — from `provide()`d providers (awaited) or the `imports` map — and returns
 * the created plugin object directly (the real loader instead returns a
 * declaration and calls `create` later). Optional deps (`'name?'`) resolve to
 * `undefined` when nothing provides them; missing required deps throw.
 *
 * @param {{ config?: Record<string, unknown>, imports?: Record<string, unknown>, root?: string }} [opts]
 * @returns {import('./contract.js').MkadocPluginHost & { _test: object }}
 */
export function createTestHost({ config = {}, imports = {}, root = process.cwd() } = {}) {
  const state = {
    headLinks: [],
    headScripts: [],
    chromeBody: [],
    classifiers: [],
    siteWideDeps: [],
    assetPrefixes: [],
    /** @type {Map<string, () => unknown>} DI providers (name → provider factory) */
    provides: new Map(),
    renderers: [],
    /** Last value passed to the `site-root` command capability. */
    siteRoot: null,
  }

  // Core-provided command capability (mirrors src/plugin/registry.js
  // provideCore seeding): plugins consume it via host.plugin(['site-root'],
  // (setSiteRoot) => …) and call it to set where `/` redirects. Recorded so
  // tests can assert what was set.
  state.provides.set('site-root', () => (href) => {
    state.siteRoot = href ?? null
  })

  function ensureDir(relOrAbs) {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs)
    fs.mkdirSync(abs, { recursive: true })
    return abs
  }

  /** Resolve one dependency name against provides + imports; `?` = optional. */
  async function resolveDeps(deps) {
    const resolved = []
    for (const raw of deps) {
      const optional = String(raw).endsWith('?')
      const name = optional ? String(raw).slice(0, -1) : String(raw)
      if (state.provides.has(name)) {
        resolved.push(await state.provides.get(name)())
      } else if (Object.hasOwn(imports, name)) {
        resolved.push(imports[name])
      } else if (optional) {
        resolved.push(undefined)
      } else {
        throw new Error(
          `mkadoc test host: plugin depends on "${name}" but no provider registered it (use host.provide(name, () => value) or createTestHost({ imports }) — optional deps end with "?")`,
        )
      }
    }
    return resolved
  }

  const host = {
    config: {
      root,
      sources: [],
      output: 'site',
      site: { brand: 'Docs' },
      plugins: {},
      serve: { remote: false, port: 8000 },
      ...config,
    },
    root,

    async import(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier]
      throw new Error(
        `mkadoc test host: no module registered for ${JSON.stringify(specifier)} (register via createTestHost({ imports }))`,
      )
    },

    registerRenderer(renderer) {
      state.renderers.push(renderer)
    },

    provide(name, provider, _opts) {
      state.provides.set(name, provider)
    },

    /** Core-internal session stub (see contract.js — builtins only). */
    session: {
      nav: { referenced: new Set(), labels: new Map() },
      plugin: { signature: null, dispose: null },
      build: { siteRoot: null },
      pageMeta: {
        clear() {},
        async get(absPath, renderer) {
          const text = fs.readFileSync(absPath, 'utf8')
          const meta = await renderer.extractMeta(text, absPath)
          return {
            title: String(meta.title ?? '').trim(),
            navLabel: String(meta.navLabel ?? '').trim() || undefined,
          }
        },
      },
    },

    async plugin(deps, create) {
      return create(...(await resolveDeps(deps)))
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
      state.siteWideDeps.push(relPath)
    },

    registerAssetPrefix(prefix) {
      const norm = `${prefix.replace(/\/$/, '')}/`
      if (!state.assetPrefixes.includes(norm)) state.assetPrefixes.push(norm)
    },

    ensureDir,

    cacheDir(name) {
      return ensureDir(path.join('.mkadoc', name))
    },

    relToRoot(p) {
      let out = p
      if (path.isAbsolute(out)) {
        const prefix = root.endsWith(path.sep) ? root : root + path.sep
        if (out.startsWith(prefix)) out = out.slice(prefix.length)
      }
      if (out.startsWith('./')) out = out.slice(2)
      return out.split(path.sep).join('/')
    },

    _test: state,
  }

  return Object.freeze(host)
}
