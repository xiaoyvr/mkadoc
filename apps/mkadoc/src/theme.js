import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileIfChanged, resolveSiteAsset, writeIfChanged } from './fs-utils.js'

/** Asciidoctor default stylesheet (MIT) — mkadoc's default theme. */
const DEFAULT_THEME_CSS = fs
  .readFileSync(fileURLToPath(new URL('./theme-default.css', import.meta.url)), 'utf8')
  .trim()

/**
 * Bundled web fonts (Open Sans, Noto Serif, Noto Sans Mono — SIL OFL 1.1,
 * variable woff2, latin subset) served locally under `/styles/fonts/`, so
 * pages never hit Google at view time. `url(fonts/…)` is relative to
 * `/styles/theme.css` → resolves to `/styles/fonts/…`.
 */
const FONT_FACES_CSS = fs
  .readFileSync(fileURLToPath(new URL('./assets/fonts/fonts.css', import.meta.url)), 'utf8')
  .trim()
const FONT_FILES = [
  'open-sans-normal.woff2',
  'open-sans-italic.woff2',
  'noto-serif-normal.woff2',
  'noto-serif-italic.woff2',
  'noto-sans-mono-normal.woff2',
]

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
 * Write `/styles/theme.css` = @font-face rules + default theme +
 * first-source `_theme/theme.css`; ship the bundled woff2 files to
 * `/styles/fonts/`.
 * @param {string} root
 * @param {string} output
 * @param {import('./sources.js').MkadocSource[]} sources
 */
export function writeThemeCss(root, output, sources) {
  for (const name of FONT_FILES) {
    const src = fileURLToPath(new URL(`./assets/fonts/${name}`, import.meta.url))
    copyFileIfChanged(src, path.join(root, output, 'styles', 'fonts', name))
  }

  const parts = [FONT_FACES_CSS, DEFAULT_THEME_CSS]
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
