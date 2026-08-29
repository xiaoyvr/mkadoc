import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config.js'
import { writeIfChanged } from './fs-utils.js'

const DEPS_VERSION = 1
const DEPS_REL = `${CACHE_DIR}/deps.json`

/**
 * Page → included files (repo-relative). Core-owned rebuild dependency graph.
 * Reverse edges are derived for "what pages to rebuild when P changes".
 * Includes are reported by renderers (the Asciidoctor include:: processor lives
 * in the mkadoc:asciidoc renderer now).
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
 * @param {string} root
 * @returns {DependencyGraph}
 */
export function loadDependencyGraph(root) {
  const graph = new DependencyGraph(root)
  graph.load()
  return graph
}
