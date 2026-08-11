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
 * Copy files from each `{ from, to }` directory under `root`.
 * Skips missing sources; skips unchanged files.
 *
 * @param {string} root
 * @param {{ from: string, to: string }[]} items
 */
export function copyAssetDirs(root, items = []) {
  for (const item of items) {
    const from = path.join(root, item.from)
    const to = path.join(root, item.to)
    fs.mkdirSync(to, { recursive: true })
    if (!fs.existsSync(from)) continue
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      const src = path.join(from, ent.name)
      const dest = path.join(to, ent.name)
      if (sameFileContent(src, dest)) continue
      fs.copyFileSync(src, dest)
    }
  }
}
