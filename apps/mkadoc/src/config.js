import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { parse as parseYaml } from 'yaml'
import { parseProjectConfig, parseServeConfig } from './config-schema.js'
import { normalizeSources } from './sources.js'

/** Fixed build-cache directory (not configurable). */
export const CACHE_DIR = '.cache'

/**
 * Runtime project config exposed to plugins as `host.config`.
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {import('./sources.js').MkadocSource[]} sources
 * @property {string} output
 * @property {string} docinfoDir
 * @property {Record<string, Record<string, unknown>>} plugins
 * @property {{ remote: boolean, port: number }} serve
 */

const CONFIG_EXTS = new Set(['.adoc', '.asciidoc'])

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

function parseConfigYaml(yamlText) {
  try {
    return parseYaml(yamlText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`mkadoc: invalid YAML in [mkadoc-config] block: ${detail}`)
  }
}

async function loadLiterateConfig(source) {
  const doc = await load(source, { safe: 'unsafe', standalone: false })
  let merged = {}
  let sawBlock = false

  for (const block of doc.findBy((b) => b.getStyle() === 'mkadoc-config')) {
    sawBlock = true
    const yamlText = block.getSource?.() ?? (block.lines || []).join('\n')
    if (!yamlText.trim()) continue
    const parsed = parseConfigYaml(yamlText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      merged = deepMerge(merged, parsed)
    } else if (parsed != null) {
      throw new Error('mkadoc: [mkadoc-config] block must be a YAML mapping')
    }
  }

  if (!sawBlock) {
    throw new Error('mkadoc: config must contain at least one [mkadoc-config] block')
  }

  return merged
}

export function resolveServeListen(serve = {}) {
  const { port, remote } = parseServeConfig(serve)
  return { host: remote ? '0.0.0.0' : '127.0.0.1', port, remote }
}

async function finalizeConfig(raw, root, abs) {
  const cfg = parseProjectConfig(raw)
  const sources = await normalizeSources(cfg.sources, root)
  return {
    ...cfg,
    sources,
    root,
    configPath: abs,
    docinfoDir: path.join(CACHE_DIR, 'docinfo'),
  }
}

export async function loadConfig(configPath, root = process.cwd()) {
  const abs = path.resolve(root, configPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`mkadoc: config not found: ${abs}`)
  }

  const ext = path.extname(abs).toLowerCase()
  if (!CONFIG_EXTS.has(ext)) {
    throw new Error(`mkadoc: unsupported config type "${ext}" (use .adoc or .asciidoc)`)
  }

  const text = fs.readFileSync(abs, 'utf8')
  const raw = await loadLiterateConfig(text)

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mkadoc: config must be a mapping')
  }

  return finalizeConfig(raw, root, abs)
}

export function defaultConfigPath() {
  return 'mkadoc.adoc'
}
