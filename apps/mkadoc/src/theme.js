import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSiteAsset, writeIfChanged } from './fs-utils.js'

/** Asciidoctor default stylesheet (MIT) — mkadoc's default theme. */
const DEFAULT_THEME_CSS = fs
  .readFileSync(fileURLToPath(new URL('./theme-default.css', import.meta.url)), 'utf8')
  .trim()

export const THEME_CSS_HREF = '/styles/theme.css'

/** Convention: customization lives under the first source's `_theme/` dir. */
export function themeDirForSource(source) {
  return `${source.path}/_theme`
}

/**
 * Read a plain CSS override file from the first source's `_theme/` dir.
 * @param {string} root
 * @param {import('./sources.js').MkadocSource} source
 * @param {string} name e.g. `theme.css`, `topbar.css`, `nav.css`
 * @returns {string | null}
 */
export function readThemeOverride(root, source, name) {
  const abs = path.join(root, themeDirForSource(source), name)
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
}

/**
 * Write `/styles/theme.css` = default theme + first-source `_theme/theme.css`.
 * @param {string} root
 * @param {string} output
 * @param {import('./sources.js').MkadocSource[]} sources
 */
export function writeThemeCss(root, output, sources) {
  const parts = [DEFAULT_THEME_CSS]
  const first = sources[0]
  if (first) {
    const override = readThemeOverride(root, first, 'theme.css')
    if (override) {
      parts.push(`/* Overrides from ${themeDirForSource(first)}/theme.css */\n${override}`)
    }
  }
  const asset = resolveSiteAsset(root, output, THEME_CSS_HREF)
  writeIfChanged(asset.absPath, `${parts.join('\n\n').trim()}\n`)
  return asset
}
