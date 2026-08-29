import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseProjectConfig, parseServeConfig } from './config-schema.js'
import { normalizeSources } from './sources.js'

/** Fixed build-cache directory (not configurable). */
export const CACHE_DIR = '.mkadoc'

/**
 * Runtime project config exposed to plugins as `host.config`.
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {import('./sources.js').MkadocSource[]} sources
 * @property {string} output
 * @property {Record<string, Record<string, unknown>>} plugins
 * @property {{ remote: boolean, port: number }} serve
 */

const CONFIG_EXTS = new Set(['.yaml', '.yml'])

function parseConfigYaml(yamlText) {
  try {
    return parseYaml(yamlText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`mkadoc: invalid YAML in config: ${detail}`)
  }
}

export function resolveServeListen(serve = {}) {
  const { port, remote } = parseServeConfig(serve)
  return { host: remote ? '0.0.0.0' : '127.0.0.1', port, remote }
}

function finalizeConfig(raw, root, abs) {
  const cfg = parseProjectConfig(raw)
  const sources = normalizeSources(cfg.sources)
  return {
    ...cfg,
    sources,
    root,
    configPath: abs,
  }
}

/**
 * @param {string} configPath
 * @param {string} [root]
 * @returns {Promise<MkadocConfig>}
 */
export async function loadConfig(configPath, root = process.cwd()) {
  const abs = path.resolve(root, configPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`mkadoc: config not found: ${abs}`)
  }

  const ext = path.extname(abs).toLowerCase()
  if (!CONFIG_EXTS.has(ext)) {
    throw new Error(`mkadoc: unsupported config type "${ext}" (use .yaml or .yml)`)
  }

  const text = fs.readFileSync(abs, 'utf8')
  const raw = parseConfigYaml(text)

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mkadoc: config must be a YAML mapping')
  }

  return finalizeConfig(raw, root, abs)
}

export function defaultConfigPath() {
  return 'mkadoc.yaml'
}
