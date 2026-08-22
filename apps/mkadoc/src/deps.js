import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config.js'
import { relToRoot, writeIfChanged } from './fs-utils.js'

const DEPS_VERSION = 1
const DEPS_REL = `${CACHE_DIR}/deps.json`

/** @type {AsyncLocalStorage<{ files: string[], root: string, baseDir: string }>} */
const includeCollect = new AsyncLocalStorage()

/**
 * Page → included files (repo-relative). Core-owned rebuild dependency graph.
 * Reverse edges are derived for "what pages to rebuild when P changes".
 */
export class DependencyGraph {
  /** @param {string} root */
  constructor(root) {
    this.root = root
    /** @type {Map<string, string[]>} */
    this.pages = new Map()
    /**
     * Paths whose change rebuilds every live page (header chrome baked into HTML).
     * Ephemeral — registered each build by core/plugins; not persisted.
     * @type {Set<string>}
     */
    this.siteWide = new Set()
  }

  /** @returns {string} */
  cachePath() {
    return path.join(this.root, DEPS_REL)
  }

  /**
   * Mark `relPath` as affecting every page (virtual include for the whole site).
   * @param {string} relPath
   */
  addSiteWide(relPath) {
    const key = normalizeRel(relPath)
    if (key) this.siteWide.add(key)
  }

  /** @param {string} relPath */
  isSiteWide(relPath) {
    return this.siteWide.has(normalizeRel(relPath))
  }

  /**
   * @param {string} page repo-relative page path
   * @param {Iterable<string>} includes repo-relative include targets
   */
  setPageIncludes(page, includes) {
    const normPage = normalizeRel(page)
    const uniq = [...new Set([...includes].map(normalizeRel).filter(Boolean))].sort()
    this.pages.set(normPage, uniq)
  }

  /** @param {string} page */
  removePage(page) {
    this.pages.delete(normalizeRel(page))
  }

  /**
   * Drop pages not in `livePages`, keep the rest.
   * @param {Iterable<string>} livePages
   */
  retainPages(livePages) {
    const live = new Set([...livePages].map(normalizeRel))
    for (const page of this.pages.keys()) {
      if (!live.has(page)) this.pages.delete(page)
    }
  }

  /** @returns {Map<string, Set<string>>} include → pages */
  reverse() {
    /** @type {Map<string, Set<string>>} */
    const rev = new Map()
    for (const [page, includes] of this.pages) {
      for (const inc of includes) {
        let set = rev.get(inc)
        if (!set) {
          set = new Set()
          rev.set(inc, set)
        }
        set.add(page)
      }
    }
    return rev
  }

  /**
   * Pages that must be rebuilt when `relPath` changes.
   * Site-wide deps return every `livePage`. Nested includes are flattened into
   * each page's include list at convert time.
   * @param {string} relPath
   * @param {{ livePages?: Iterable<string> }} [opts]
   * @returns {string[]}
   */
  pagesDependingOn(relPath, { livePages = [] } = {}) {
    const key = normalizeRel(relPath)
    if (this.siteWide.has(key)) {
      return [...new Set([...livePages].map(normalizeRel).filter(Boolean))].sort()
    }
    const pages = this.reverse().get(key)
    return pages ? [...pages].sort() : []
  }

  load() {
    const abs = this.cachePath()
    if (!fs.existsSync(abs)) {
      this.pages.clear()
      return false
    }
    try {
      const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
      if (!raw || raw.version !== DEPS_VERSION || typeof raw.pages !== 'object' || !raw.pages) {
        this.pages.clear()
        return false
      }
      this.pages.clear()
      for (const [page, includes] of Object.entries(raw.pages)) {
        if (!Array.isArray(includes)) continue
        this.setPageIncludes(
          page,
          includes.filter((x) => typeof x === 'string'),
        )
      }
      return true
    } catch {
      this.pages.clear()
      return false
    }
  }

  save() {
    const pages = {}
    for (const [page, includes] of [...this.pages.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      pages[page] = includes
    }
    const body = `${JSON.stringify({ version: DEPS_VERSION, pages }, null, 2)}\n`
    writeIfChanged(this.cachePath(), body)
  }
}

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/**
 * Directory used to resolve an include target for the current reader cursor.
 * @param {{ path?: string, _dir?: string }} reader
 * @param {string} fallbackBaseDir absolute
 */
export function includeResolveDir(reader, fallbackBaseDir) {
  const filePath = reader.path
  if (filePath && filePath !== '<stdin>' && path.isAbsolute(filePath)) {
    return path.dirname(filePath)
  }
  if (reader._dir && path.isAbsolute(reader._dir)) return reader._dir
  if (reader._dir) return path.resolve(fallbackBaseDir, reader._dir)
  return fallbackBaseDir
}

function isUriTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(target))
}

/**
 * Register a core IncludeProcessor that records resolved local includes into
 * the active AsyncLocalStorage bag (see {@link withIncludeCollector}).
 * @param {import('@asciidoctor/core').Extensions.Registry} registry
 */
export function registerIncludeCollector(registry) {
  registry.includeProcessor(function () {
    this.handles((target) => !isUriTarget(target))
    this.process((doc, reader, target, attrs) => {
      const store = includeCollect.getStore()
      const fallback =
        store?.baseDir ||
        doc?.getBaseDir?.() ||
        doc?.base_dir ||
        (reader._dir && path.isAbsolute(reader._dir) ? reader._dir : null)

      if (!fallback) return

      const base = includeResolveDir(reader, fallback)
      const resolved = path.resolve(base, String(target))
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        if (store) console.warn(`mkadoc: unresolved include: ${target}`)
        return
      }

      if (store) {
        const rel = relToRoot(resolved, store.root)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          store.files.push(rel)
        }
      }

      reader.pushInclude(fs.readFileSync(resolved, 'utf8'), target, resolved, 1, attrs)
    })
  })
}

/**
 * Run `fn` while collecting include paths into a bag.
 * @template T
 * @param {{ root: string, baseDir: string }} ctx
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<{ result: T, includes: string[] }>}
 */
export async function withIncludeCollector(ctx, fn) {
  const bag = { files: /** @type {string[]} */ ([]), root: ctx.root, baseDir: ctx.baseDir }
  const result = await includeCollect.run(bag, fn)
  const includes = [...new Set(bag.files.map(normalizeRel))].sort()
  return { result, includes }
}

/**
 * @param {string} root
 * @returns {DependencyGraph}
 */
export function loadDependencyGraph(root) {
  const graph = new DependencyGraph(root)
  graph.load()
  return graph
}
