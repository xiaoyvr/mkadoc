import fs from 'node:fs'
import path from 'node:path'

/**
 * Normalize a path to a repo-root-relative POSIX path.
 * @param {string} p
 * @param {string} root
 */
export function relToRoot(p, root) {
  let out = p
  if (path.isAbsolute(out)) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (out.startsWith(prefix)) out = out.slice(prefix.length)
  }
  if (out.startsWith('./')) out = out.slice(2)
  return out.split(path.sep).join('/')
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sameFileContent(a, b) {
  if (!fs.existsSync(b)) return false
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

/**
 * Write UTF-8 text only when content changed.
 * @param {string} filePath
 * @param {string} content
 * @returns {boolean} true if a write occurred
 */
export function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return false
  }
  fs.writeFileSync(filePath, content)
  return true
}

/**
 * Map a site-root href (e.g. `/styles/nav.css`) to a path under `output/`.
 * The same href is used for `<link>`/`<script>` and for the on-disk write target.
 *
 * @param {string} root project root
 * @param {string} output output dir relative to root
 * @param {string} href root-absolute site path (leading `/`)
 * @returns {{ href: string, absPath: string, relPath: string }}
 */
export function resolveSiteAsset(root, output, href) {
  const raw = String(href ?? '').trim()
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new Error(
      `mkadoc: site asset href must be a root-absolute path starting with / (got ${JSON.stringify(href)})`,
    )
  }
  const pathname = raw.split(/[?#]/, 1)[0]
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean)
  if (parts.length === 0 || parts.includes('..') || parts.includes('.')) {
    throw new Error(`mkadoc: invalid site asset href: ${JSON.stringify(href)}`)
  }
  const relPath = parts.join('/')
  const out = String(output).replace(/[/\\]+$/, '')
  const outAbs = path.resolve(root, out)
  const absPath = path.resolve(outAbs, ...parts)
  const prefix = outAbs.endsWith(path.sep) ? outAbs : outAbs + path.sep
  if (absPath !== outAbs && !absPath.startsWith(prefix)) {
    throw new Error(`mkadoc: site asset href escapes output dir: ${JSON.stringify(href)}`)
  }
  return { href: `/${relPath}`, absPath, relPath }
}

/**
 * Recursively walk a directory tree.
 * Missing roots are skipped by default (`missing: 'skip'`).
 *
 * @param {string} dir absolute directory path
 * @param {{
 *   missing?: 'skip' | 'throw',
 *   shouldEnterDir?: (full: string, name: string) => boolean,
 *   onFile?: (full: string, name: string) => void,
 * }} [opts]
 */
export function walkDir(dir, { missing = 'skip', shouldEnterDir, onFile } = {}) {
  if (!fs.existsSync(dir)) {
    if (missing === 'skip') return
    throw new Error(`mkadoc: walkDir: directory not found: ${dir}`)
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (shouldEnterDir && !shouldEnterDir(full, ent.name)) continue
      walkDir(full, { missing, shouldEnterDir, onFile })
    } else if (ent.isFile()) {
      onFile?.(full, ent.name)
    }
  }
}

/**
 * Recursively copy files from each `{ from, to }` directory under `root`.
 * Preserves relative paths; skips missing sources and unchanged files.
 * Skips `node_modules` and `.git` directory names while walking.
 *
 * @param {string} root
 * @param {{ from: string, to: string }[]} items
 */
export function copyAssetDirs(root, items = []) {
  for (const item of items) {
    const from = path.join(root, item.from)
    const to = path.join(root, item.to)
    fs.mkdirSync(to, { recursive: true })
    walkDir(from, {
      shouldEnterDir: (_full, name) => name !== 'node_modules' && name !== '.git',
      onFile: (src) => {
        const rel = path.relative(from, src)
        const dest = path.join(to, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        if (sameFileContent(src, dest)) return
        fs.copyFileSync(src, dest)
      },
    })
  }
}
