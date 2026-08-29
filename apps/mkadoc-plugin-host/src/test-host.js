import fs from 'node:fs'
import path from 'node:path'

/**
 * In-memory / on-disk test double for {@link import('./contract.js').MkadocPluginHost}.
 * Records hook calls into `host._test` for assertions; `import` serves from a
 * caller-provided module map (e.g. `{ zod: { z } }`).
 *
 * @param {{ config?: Record<string, unknown>, imports?: Record<string, unknown>, root?: string }} [opts]
 * @returns {import('./contract.js').MkadocPluginHost & { _test: object }}
 */
export function createTestHost({ config = {}, imports = {}, root = process.cwd() } = {}) {
  const state = {
    attributes: {},
    headLinks: [],
    headScripts: [],
    chromeBody: [],
    classifiers: [],
    siteWideDeps: [],
    assetPrefixes: [],
    services: new Map(),
    renderers: [],
  }

  function ensureDir(relOrAbs) {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs)
    fs.mkdirSync(abs, { recursive: true })
    return abs
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

    provideService(name, service) {
      state.services.set(name, service)
    },

    getService(name) {
      return state.services.get(name)
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
