import fs from 'node:fs'
import path from 'node:path'

export function relToRoot(p, root) {
  let out = p
  if (path.isAbsolute(out)) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (out.startsWith(prefix)) out = out.slice(prefix.length)
  }
  if (out.startsWith('./')) out = out.slice(2)
  return out.split(path.sep).join('/')
}

export function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return false
  }
  fs.writeFileSync(filePath, content)
  return true
}

/** Copy a file, skipping the write when the destination already matches. */
export function copyFileIfChanged(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) {
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    if (a.size === b.size && fs.readFileSync(dest).equals(fs.readFileSync(src))) {
      return false
    }
  }
  fs.copyFileSync(src, dest)
  return true
}

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
