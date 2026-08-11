import fs from 'node:fs'
import path from 'node:path'
import { Extensions } from '@asciidoctor/core'
import { relToRoot, writeIfChanged } from '../fs-utils.js'
import { escapeHtmlAttr } from '../html-utils.js'
import './contract.js'

/**
 * @param {import('../config.js').MkadocConfig} cfg
 * @returns {import('./contract.js').MkadocHost}
 */
export function createHost(cfg) {
  const registry = Extensions.create()
  /** @type {Record<string, unknown>} */
  const attributes = {}
  /** @type {{ rel: string, href: string, [k: string]: unknown }[]} */
  const headLinks = []
  /** @type {{ src: string, [k: string]: unknown }[]} */
  const headScripts = []
  /** @type {((p: string) => 'full' | null | undefined)[]} */
  const classifiers = []
  /** @type {string[]} */
  const assetPrefixes = []
  let headerProvided = false

  /** @type {import('./contract.js').MkadocHost} */
  const host = {
    config: cfg,
    root: cfg.root,
    registry,
    attributes,
    headLinks,
    headScripts,
    assetPrefixes,
    classifiers,

    registerExtension(registerFn) {
      registerFn(registry)
    },

    addAttributes(attrs) {
      Object.assign(attributes, attrs)
    },

    contributeHead({ links = [], scripts = [] } = {}) {
      headLinks.push(...links)
      headScripts.push(...scripts)
    },

    registerClassifier(fn) {
      classifiers.push(fn)
    },

    registerAssetPrefix(prefix) {
      const norm = `${prefix.replace(/\/$/, '')}/`
      if (!assetPrefixes.includes(norm)) assetPrefixes.push(norm)
    },

    ensureDir(relOrAbs) {
      const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cfg.root, relOrAbs)
      fs.mkdirSync(abs, { recursive: true })
      return abs
    },

    cacheDir(name) {
      return host.ensureDir(path.join(cfg.cache, name))
    },

    relToRoot(p) {
      return relToRoot(p, cfg.root)
    },

    headerDocinfoPath() {
      return path.join(cfg.root, cfg.docinfoDir, 'docinfo-header.html')
    },

    headerDocinfoExists() {
      return fs.existsSync(host.headerDocinfoPath())
    },

    markHeaderProvided() {
      headerProvided = true
    },

    async writeHeaderDocinfo(html) {
      writeIfChanged(host.headerDocinfoPath(), html)
      headerProvided = true
    },

    writeHeadDocinfo() {
      const lines = []
      for (const link of headLinks) {
        const attrs = Object.entries(link)
          .map(([k, v]) => (v === true ? k : `${k}="${escapeHtmlAttr(v)}"`))
          .join(' ')
        lines.push(`<link ${attrs}>`)
      }
      for (const script of headScripts) {
        const { src, defer, async: isAsync, ...rest } = script
        const parts = [`src="${escapeHtmlAttr(src)}"`]
        if (defer) parts.push('defer')
        if (isAsync) parts.push('async')
        for (const [k, v] of Object.entries(rest)) {
          parts.push(v === true ? k : `${k}="${escapeHtmlAttr(v)}"`)
        }
        lines.push(`<script ${parts.join(' ')}></script>`)
      }
      const out = path.join(cfg.root, cfg.docinfoDir, 'docinfo.html')
      const body = lines.join('\n') + (lines.length ? '\n' : '')
      return writeIfChanged(out, body)
    },

    wantsDocinfo() {
      // Only enable docinfo when a plugin contributed chrome this build.
      // Do not reuse stale cache/docinfo from a previous plugin-enabled run.
      return headerProvided || headLinks.length > 0 || headScripts.length > 0
    },

    classifyPath(p) {
      for (const fn of classifiers) {
        const result = fn(p)
        if (result === 'full') return 'full'
      }
      return null
    },
  }

  return host
}
