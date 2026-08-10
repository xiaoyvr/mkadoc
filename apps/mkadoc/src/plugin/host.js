import { convertFile, Extensions } from '@asciidoctor/core'
import fs from 'node:fs'
import path from 'node:path'

function sameFileContent(a, b) {
  if (!fs.existsSync(b)) return false
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

/**
 * @param {object} cfg
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
  /** @type {string[]} */
  const extraDirs = []
  let headerProvided = false

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
      const norm = prefix.replace(/\/$/, '') + '/'
      if (!assetPrefixes.includes(norm)) assetPrefixes.push(norm)
    },

    ensureDir(relOrAbs) {
      const abs = path.isAbsolute(relOrAbs)
        ? relOrAbs
        : path.join(cfg.root, relOrAbs)
      extraDirs.push(abs)
      fs.mkdirSync(abs, { recursive: true })
      return abs
    },

    cacheDir(name) {
      return host.ensureDir(path.join(cfg.cache, name))
    },

    relToRoot(p) {
      let out = p
      if (path.isAbsolute(out)) {
        const prefix = cfg.root.endsWith(path.sep) ? cfg.root : cfg.root + path.sep
        if (out.startsWith(prefix)) out = out.slice(prefix.length)
      }
      if (out.startsWith('./')) out = out.slice(2)
      return out.split(path.sep).join('/')
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
      const out = host.headerDocinfoPath()
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (!(fs.existsSync(out) && fs.readFileSync(out, 'utf8') === html)) {
        fs.writeFileSync(out, html)
      }
      headerProvided = true
    },

    async convertFile(filePath, opts = {}) {
      const abs = path.isAbsolute(filePath)
        ? filePath
        : path.join(cfg.root, filePath)
      return convertFile(abs, {
        safe: 'unsafe',
        mkdirs: true,
        ...opts,
      })
    },

    copyAssets(items = []) {
      for (const item of items) {
        const from = path.join(cfg.root, item.from)
        const to = path.join(cfg.root, item.to)
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
    },

    writeHeadDocinfo() {
      const lines = []
      for (const link of headLinks) {
        const attrs = Object.entries(link)
          .map(([k, v]) => (v === true ? k : `${k}="${v}"`))
          .join(' ')
        lines.push(`<link ${attrs}>`)
      }
      for (const script of headScripts) {
        const { src, defer, async: isAsync, ...rest } = script
        const parts = [`src="${src}"`]
        if (defer) parts.push('defer')
        if (isAsync) parts.push('async')
        for (const [k, v] of Object.entries(rest)) {
          parts.push(v === true ? k : `${k}="${v}"`)
        }
        lines.push(`<script ${parts.join(' ')}></script>`)
      }
      const out = path.join(cfg.root, cfg.docinfoDir, 'docinfo.html')
      const body = lines.join('\n') + (lines.length ? '\n' : '')
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === body) return false
      fs.writeFileSync(out, body)
      return true
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
