import fs from 'node:fs'

/**
 * Session-scoped page-metadata cache (`extractMeta` results keyed by
 * path + mtime). Nav and the site map both resolve every page's title/label
 * on each build; on large sites, unchanged pages are re-parsed once instead of
 * on every pass. mtime invalidation makes staleness impossible; the size cap
 * bounds the map over long `serve` sessions.
 */
const cache = new Map()
const MAX_ENTRIES = 5000

/**
 * @param {string} absPath
 * @param {import('./plugin/contract.js').MkadocRenderer} renderer
 * @returns {Promise<{ title: string, navLabel?: string }>}
 */
export async function pageMeta(absPath, renderer) {
  const key = `${absPath}\0${fs.statSync(absPath).mtimeMs}`
  const hit = cache.get(key)
  if (hit) return hit
  const text = fs.readFileSync(absPath, 'utf8')
  const meta = await renderer.extractMeta(text, absPath)
  const result = {
    title: String(meta.title ?? '').trim(),
    navLabel: String(meta.navLabel ?? '').trim() || undefined,
  }
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(key, result)
  return result
}
