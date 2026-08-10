import { load } from '@asciidoctor/core'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

const DEFAULTS = {
  source: 'docs',
  output: 'site',
  cache: '.cache/asciidoctor',
  assets: [],
  plugins: {},
  serve: {
    // false → localhost only (127.0.0.1); true → all interfaces (0.0.0.0)
    remote: false,
    port: 8000,
  },
}

/**
 * Deep-merge plain objects; arrays and scalars from `next` replace.
 * @param {object} base
 * @param {object} next
 */
function deepMerge(base, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next
  const out = { ...base }
  for (const [key, value] of Object.entries(next)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Extract and deep-merge YAML from `[mkadoc-config]` listing blocks.
 * @param {string} source
 */
export async function loadLiterateConfig(source) {
  const doc = await load(source, { safe: 'unsafe', standalone: false })
  let merged = {}

  for (const block of doc.findBy((b) => b.getStyle() === 'mkadoc-config')) {
    const yamlText = block.getSource?.() ?? (block.lines || []).join('\n')
    if (!yamlText.trim()) continue
    const parsed = parseYaml(yamlText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      merged = deepMerge(merged, parsed)
    } else if (parsed != null) {
      throw new Error('mkadoc: [mkadoc-config] block must be a YAML mapping')
    }
  }

  return merged
}

/**
 * Resolve listen address from serve config.
 * Prefer `remote` boolean; optional `host` is an advanced override.
 *
 * @param {object} serve
 */
export function resolveServeListen(serve = {}) {
  const port = Number(serve.port ?? DEFAULTS.serve.port)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`mkadoc: invalid serve.port: ${serve.port}`)
  }

  let host
  if (typeof serve.host === 'string' && serve.host.trim()) {
    host = serve.host.trim()
  } else if (serve.remote) {
    host = '0.0.0.0'
  } else {
    host = '127.0.0.1'
  }

  return {
    host,
    port,
    remote: host !== '127.0.0.1' && host !== '::1',
  }
}

function finalizeConfig(raw, root, abs) {
  const cfg = {
    ...DEFAULTS,
    ...raw,
    plugins: raw.plugins ?? DEFAULTS.plugins,
    assets: raw.assets ?? DEFAULTS.assets,
    serve: { ...DEFAULTS.serve, ...(raw.serve || {}) },
  }

  cfg.root = root
  cfg.configPath = abs
  cfg.docinfoDir = path.join(cfg.cache, 'docinfo')
  return cfg
}

/**
 * Load project config from a literate AsciiDoc file (`mkadoc.adoc`) or YAML.
 *
 * @param {string} configPath
 * @param {string} root
 */
export async function loadConfig(configPath, root = process.cwd()) {
  const abs = path.resolve(root, configPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`mkadoc: config not found: ${abs}`)
  }

  const text = fs.readFileSync(abs, 'utf8')
  const ext = path.extname(abs).toLowerCase()

  let raw
  if (ext === '.adoc' || ext === '.asciidoc') {
    raw = await loadLiterateConfig(text)
  } else if (ext === '.yml' || ext === '.yaml') {
    raw = parseYaml(text) || {}
  } else {
    throw new Error(
      `mkadoc: unsupported config type "${ext}" (use mkadoc.adoc or .yml)`,
    )
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mkadoc: config must be a mapping')
  }

  return finalizeConfig(raw, root, abs)
}

export function defaultConfigPath() {
  return 'mkadoc.adoc'
}
