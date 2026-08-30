import fs from 'node:fs'

/**
 * Per-build page-metadata cache (`extractMeta` results keyed by path). Nav and
 * the site map both resolve every page's title/label during one build; the
 * cache makes them share a single parse per page. Cleared at the start of each
 * build (`resetPageMetaCache`) — no state is retained across builds or
 * processes.
 */
const cache = new Map()

export function resetPageMetaCache() {
  cache.clear()
}

/**
 * @param {string} absPath
 * @param {import('@mkadoc/plugin-host').MkadocRenderer} renderer
 * @returns {Promise<{ title: string, navLabel?: string }>}
 */
export async function pageMeta(absPath, renderer) {
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
}
