import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Arborist from '@npmcli/arborist'
import npa from 'npm-package-arg'
import libnpmpack from 'libnpmpack'
import pacote from 'pacote'
import { CACHE_DIR } from '../config.js'

export const PLUGINS_REL = `${CACHE_DIR}/plugins`

const MARKER = '.mkadoc-install.json'

/**
 * Parse a plugin locator with npm-package-arg (the same spec grammar npm/pacote
 * use). Local folder specs (`file:./path`, `./path`, `../path`, absolute paths)
 * yield `type: 'file' | 'directory'` with `path` resolved against `root`.
 * Other types (registry ranges, git, remote tarballs, aliases) parse fine but
 * are not implemented yet.
 *
 * @param {string} locator
 * @param {string} root project root (base for relative paths)
 * @returns {{ type: string, name?: string, path?: string, raw: string }}
 */
export function parseLocator(locator, root) {
  let spec
  try {
    spec = npa(locator)
  } catch (err) {
    throw new Error(`mkadoc: invalid plugin locator ${JSON.stringify(locator)}: ${err?.message || err}`)
  }

  const out = { type: spec.type, name: spec.name, raw: locator }

  if (spec.type === 'file' || spec.type === 'directory') {
    const raw = String(spec.rawSpec ?? '').trim()
    const pathPart = raw.startsWith('file:') ? raw.slice(5) : raw
    if (!pathPart) {
      throw new Error(`mkadoc: plugin locator ${JSON.stringify(locator)} has no path`)
    }
    out.path = path.isAbsolute(pathPart) ? pathPart : path.resolve(root, pathPart)
  }
  return out
}

/** @param {string} name */
function sanitizeName(name) {
  return String(name || 'plugin')
    .replace(/^@/, '')
    .replace(/[/\\:]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
}

/** @param {string} pluginDir */
function readMarker(pluginDir) {
  const abs = path.join(pluginDir, MARKER)
  if (!fs.existsSync(abs)) return null
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} pluginDir */
function writeMarker(pluginDir, marker) {
  fs.writeFileSync(path.join(pluginDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
}

/**
 * Content hash of the plugin's dependency manifest (lockfile preferred).
 * @param {string} source
 * @returns {string | null} null when the plugin declares no manifest
 */
function lockHashOf(source) {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'package.json']) {
    const abs = path.join(source, name)
    if (fs.existsSync(abs)) {
      return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    }
  }
  return null
}

/**
 * Does the manifest declare anything arborist must install?
 * (runtime deps only — dev deps are omitted by design)
 * @param {string} pkgPath absolute package.json path
 * @returns {boolean}
 */
function manifestNeedsInstall(pkgPath) {
  if (!fs.existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg[key]
      if (deps && typeof deps === 'object' && Object.keys(deps).length > 0) return true
    }
  } catch {
    // unreadable manifest — treat as needing install so arborist surfaces the error
    return true
  }
  return false
}

/**
 * Pack the plugin source with `npm pack` semantics (`libnpmpack`, no lifecycle
 * scripts) and write the tarball next to `dest`. The tarball is the exact
 * artifact npm would install, so its sha512 is the canonical content identity.
 *
 * @param {string} source
 * @param {string} tarballPath
 * @returns {Promise<string>} sha512 hex of the packed tarball
 */
async function packPlugin(source, tarballPath) {
  const buf = await libnpmpack(source, { ignoreScripts: true })
  const integrity = crypto.createHash('sha512').update(buf).digest('hex')
  fs.mkdirSync(path.dirname(tarballPath), { recursive: true })
  fs.writeFileSync(tarballPath, buf)
  return integrity
}

/**
 * Install a local-folder plugin into `.mkadoc/plugins/<name>` by treating it as
 * a package: pack the source (`libnpmpack`), extract the tarball (`pacote`),
 * and materialize runtime deps with arborist reify (`ignoreScripts`,
 * `omit: ['dev']`). Skipped entirely when the tarball integrity is unchanged;
 * code-only edits keep the installed node_modules (deps input unchanged).
 *
 * @param {string} root project root
 * @param {string} locator
 * @returns {Promise<string>} absolute plugin dir
 */
export async function installLocalPlugin(root, locator) {
  const spec = parseLocator(locator, root)
  if (spec.type !== 'file' && spec.type !== 'directory') {
    throw new Error(
      `mkadoc: plugin ${JSON.stringify(locator)} (${spec.type}) is not supported yet — only local folder plugins are implemented (e.g. "file:./path/to/plugin")`,
    )
  }
  const source = spec.path
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`mkadoc: plugin folder not found: ${source} (from locator ${JSON.stringify(locator)})`)
  }

  const pkgPath = path.join(source, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `mkadoc: plugin folder ${source} has no package.json — local plugins must be npm packages (name/version required)`,
    )
  }
  let name = sanitizeName(path.basename(source))
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name) name = sanitizeName(pkg.name)
  } catch {
    // unreadable manifest — fall back to basename
  }

  const pluginsDir = path.join(root, PLUGINS_REL)
  const tmpDir = path.join(pluginsDir, '.tmp')
  const tarballPath = path.join(tmpDir, 'plugin.tgz')
  const pluginDir = path.join(pluginsDir, name)

  const integrity = await packPlugin(source, tarballPath)
  const lockHash = lockHashOf(source)
  const depsNeeded = manifestNeedsInstall(pkgPath)

  const marker = readMarker(pluginDir)
  const oldNodeModules = path.join(pluginDir, 'node_modules')
  const nodeModulesOk = !depsNeeded || fs.existsSync(oldNodeModules)
  const contentOk = marker && marker.integrity === integrity
  const depsOk = !depsNeeded || (marker && marker.lockHash === lockHash && nodeModulesOk)

  let changed = false
  if (!contentOk) {
    const staging = path.join(tmpDir, `${name}.staging`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    await pacote.extract(tarballPath, staging, { cache: path.join(root, CACHE_DIR, 'cache') })

    // Code-only edit: keep the existing deps when the install input is unchanged.
    if (depsNeeded && depsOk) {
      fs.renameSync(oldNodeModules, path.join(staging, 'node_modules'))
    }

    fs.rmSync(pluginDir, { recursive: true, force: true })
    fs.renameSync(staging, pluginDir)
    changed = true
  }

  if (!depsOk) {
    await reifyDeps(root, pluginDir)
    changed = true
  }

  fs.rmSync(tarballPath, { force: true })

  if (changed) {
    writeMarker(pluginDir, { integrity, lockHash, depsOk: true })
  }

  return pluginDir
}

/**
 * Materialize runtime deps of a plugin folder with arborist.
 * Never runs install scripts; never installs devDependencies.
 * @param {string} root
 * @param {string} pluginDir
 */
async function reifyDeps(root, pluginDir) {
  const cache = path.join(root, CACHE_DIR, 'cache')
  fs.mkdirSync(cache, { recursive: true })
  const arb = new Arborist({ path: pluginDir, cache, ignoreScripts: true })
  try {
    // NB: arborist reads `omit` from the reify() call, not the constructor
    await arb.reify({ omit: ['dev'] })
  } catch (err) {
    const message = err?.message || String(err)
    throw new Error(`mkadoc: plugin install failed at ${pluginDir}: ${message}`, { cause: err })
  }
}

/**
 * Resolve the plugin module entry from its installed dir:
 * package.json `main`, `exports["."].import`, then `index.js`.
 * @param {string} pluginDir
 * @returns {string} absolute entry file path
 */
export function resolveEntry(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    } catch {
      pkg = null
    }
    if (pkg) {
      const candidates = []
      if (typeof pkg.main === 'string' && pkg.main) candidates.push(pkg.main)
      const exp = pkg.exports?.['.']
      const imp = typeof exp === 'string' ? exp : exp?.import
      if (typeof imp === 'string' && imp) candidates.push(imp)
      for (const rel of candidates) {
        const abs = path.resolve(pluginDir, rel)
        if (fs.existsSync(abs)) return abs
      }
    }
  }
  const indexJs = path.join(pluginDir, 'index.js')
  if (fs.existsSync(indexJs)) return indexJs
  throw new Error(`mkadoc: plugin at ${pluginDir} has no resolvable entry (package.json main, exports, or index.js)`)
}
