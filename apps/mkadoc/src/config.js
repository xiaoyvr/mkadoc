import fs from 'node:fs'
import path from 'node:path'
import { load } from '@asciidoctor/core'
import { parse as parseYaml } from 'yaml'
import { parseProjectConfig } from './config-schema.js'
import { userError } from './errors.js'

/**
 * Runtime project config exposed to plugins as `host.config`.
 *
 * @typedef {object} MkadocConfig
 * @property {string} root
 * @property {string} configPath
 * @property {string} source
 * @property {string} output
 * @property {string} cache
 * @property {string} docinfoDir
 * @property {{ from: string, to: string }[]} assets
 * @property {Record<string, Record<string, unknown>>} plugins
 * @property {{ remote: boolean, port: number }} serve
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

async function loadLiterateConfig(source) {
  const doc = await load(source, { safe: 'unsafe', standalone: false })
  let merged = {}

  for (const block of doc.findBy((b) => b.getStyle() === 'mkadoc-config')) {
    const yamlText = block.getSource?.() ?? (block.lines || []).join('\n')
    if (!yamlText.trim()) continue
    const parsed = parseYaml(yamlText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      merged = deepMerge(merged, parsed)
    } else if (parsed != null) {
      throw userError('mkadoc: [mkadoc-config] block must be a YAML mapping')
    }
  }

  return merged
}

export function parsePort(raw, label = 'serve.port') {
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw userError(`mkadoc: invalid ${label}: ${raw}`)
  }
  return port
}

export function resolveServeListen(serve = {}) {
  const port = parsePort(serve.port ?? 8000)
  const remote = Boolean(serve.remote)
  const host = remote ? '0.0.0.0' : '127.0.0.1'
  return { host, port, remote }
}

function finalizeConfig(raw, root, abs) {
  const cfg = parseProjectConfig(raw)
  return {
    ...cfg,
    root,
    configPath: abs,
    docinfoDir: path.join(cfg.cache, 'docinfo'),
  }
}

export async function loadConfig(configPath, root = process.cwd()) {
  const abs = path.resolve(root, configPath)
  if (!fs.existsSync(abs)) {
    throw userError(`mkadoc: config not found: ${abs}`)
  }

  const text = fs.readFileSync(abs, 'utf8')
  const ext = path.extname(abs).toLowerCase()

  let raw
  if (ext === '.adoc' || ext === '.asciidoc') {
    raw = await loadLiterateConfig(text)
  } else if (ext === '.yml' || ext === '.yaml') {
    raw = parseYaml(text) || {}
  } else {
    throw userError(`mkadoc: unsupported config type "${ext}" (use mkadoc.adoc or .yml)`)
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw userError('mkadoc: config must be a mapping')
  }

  return finalizeConfig(raw, root, abs)
}

export function defaultConfigPath() {
  return 'mkadoc.adoc'
}
