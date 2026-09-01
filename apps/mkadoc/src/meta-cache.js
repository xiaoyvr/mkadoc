import fs from 'node:fs'

/**
 * Per-build page-metadata cache (`extractMeta` results keyed by path). Nav and
 * the site map both resolve every page's title/label during one build; the
 * cache makes them share a single parse per page.
 *
 * Owned by the **session** (see src/session.js) and cleared at the start of
 * each build — no module-global state, so concurrent builds in one process
 * each have their own cache.
 *
 * @returns {{
 *   clear: () => void,
 *   get: (absPath: string, renderer: import('@mkadoc/plugin-host').MkadocRenderer) => Promise<{ title: string, navLabel?: string }>,
 * }}
 */
export function createPageMetaCache() {
  /** @type {Map<string, { title: string, navLabel?: string }>} */
  const cache = new Map()

  return {
    clear() {
      cache.clear()
    },

    /**
     * @param {string} absPath
     * @param {import('@mkadoc/plugin-host').MkadocRenderer} renderer
     */
    async get(absPath, renderer) {
      const hit = cache.get(absPath)
      if (hit) return hit
      const text = fs.readFileSync(absPath, 'utf8')
      const meta = await renderer.extractMeta(text, absPath)
      const result = {
        title: String(meta.title ?? '').trim(),
        navLabel: String(meta.navLabel ?? '').trim() || undefined,
      }
      cache.set(absPath, result)
      return result
    },
  }
}
