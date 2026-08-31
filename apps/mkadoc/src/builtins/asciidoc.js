import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { Extensions, load, SyntaxHighlighter, SyntaxHighlighterBase } from '@asciidoctor/core'
import { parse } from 'node-html-parser'
import { z } from 'zod'
import { relToRoot } from '../fs-utils.js'
import { parsePluginOptions } from '../plugin/options.js'

const OptionsSchema = z.object({}).strict()

// ---------------------------------------------------------------------------
// Include tracking (moved from core: Asciidoctor's include:: is renderer-owned)
// ---------------------------------------------------------------------------

/** @type {AsyncLocalStorage<{ files: string[], root: string, baseDir: string }>} */
const includeCollect = new AsyncLocalStorage()

function isUriTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(target))
}

function includeResolveDir(reader, fallbackBaseDir) {
  const filePath = reader.path
  if (filePath && filePath !== '<stdin>' && path.isAbsolute(filePath)) {
    return path.dirname(filePath)
  }
  if (reader._dir && path.isAbsolute(reader._dir)) return reader._dir
  if (reader._dir) return path.resolve(fallbackBaseDir, reader._dir)
  return fallbackBaseDir
}

function registerIncludeCollector(registry) {
  registry.includeProcessor(function () {
    this.handles((target) => !isUriTarget(target))
    this.process((doc, reader, target, attrs) => {
      const store = includeCollect.getStore()
      const fallback =
        store?.baseDir ||
        doc?.getBaseDir?.() ||
        doc?.base_dir ||
        (reader._dir && path.isAbsolute(reader._dir) ? reader._dir : null)

      if (!fallback) return

      const base = includeResolveDir(reader, fallback)
      const resolved = path.resolve(base, String(target))
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        if (store) console.warn(`mkadoc: unresolved include: ${target}`)
        return
      }

      if (store) {
        const rel = relToRoot(resolved, store.root)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          store.files.push(rel)
        }
      }

      reader.pushInclude(fs.readFileSync(resolved, 'utf8'), target, resolved, 1, attrs)
    })
  })
}

async function withIncludeCollector(ctx, fn) {
  const bag = { files: /** @type {string[]} */ ([]), root: ctx.root, baseDir: ctx.baseDir }
  const result = await includeCollect.run(bag, fn)
  const norm = (p) => String(p).replace(/\\/g, '/')
  const includes = [...new Set(bag.files.map(norm))].sort()
  return { result, includes }
}

// ---------------------------------------------------------------------------
// Syntax-highlight bridge: delegate to the injected `syntax-highlight` value
// ---------------------------------------------------------------------------

/**
 * Per-instance syntax-highlight bridge: the class closes over the resolved
 * `syntax-highlight` capability (injected via host.plugin deps), so the
 * adapter never does a service lookup. Registered with Asciidoctor under
 * `mkadoc-syntax`; re-registering replaces the previous class (builds are
 * sequential, so the current build's class is always the active one).
 * @param {{ highlight: (code: string, lang: string) => string }} syntaxHighlight
 */
function registerServiceSyntaxHighlighter(syntaxHighlight) {
  class ServiceSyntaxHighlighter extends SyntaxHighlighterBase {
    constructor(name, backend, opts = {}) {
      super(name, backend, opts)
      this.name = 'mkadoc-syntax'
      this._preClass = 'shiki'
    }

    highlight(_node, source, lang) {
      if (!syntaxHighlight) {
        throw new Error('mkadoc:asciidoc: syntax-highlight capability is not available')
      }
      return syntaxHighlight.highlight(String(source), String(lang || ''))
    }

    handlesHighlighting() {
      return true
    }
  }
  SyntaxHighlighter.register(ServiceSyntaxHighlighter, 'mkadoc-syntax')
}

// ---------------------------------------------------------------------------
// Full-document → body/meta extraction (core owns the page wrapper)
// ---------------------------------------------------------------------------

/** Extract everything between `<body ...>` and `</body>`. */
function extractBody(html) {
  const body = parse(html).querySelector('body')
  return body ? body.innerHTML : html
}

/** Keep renderer-owned `<meta>` tags, dropping the ones core's template owns. */
function extractHeadMeta(html) {
  const head = parse(html).querySelector('head')
  if (!head) return ''
  const owned = (m) =>
    m.getAttribute('charset') != null ||
    m.getAttribute('http-equiv') === 'X-UA-Compatible' ||
    m.getAttribute('name') === 'viewport' ||
    m.getAttribute('name') === 'generator'
  return head
    .querySelectorAll('meta')
    .filter((m) => !owned(m))
    .map((m) => m.outerHTML)
    .join('\n')
}

function isExternalOrAbsoluteTarget(target) {
  if (target.startsWith('#') || target.startsWith('/')) return true
  return /^[a-z][a-z0-9+.-]*:/i.test(target)
}

const ASSET_SKIP_RE = /\.(?:html?|adoc|asciidoc)$/i

/** Resolve a converted document's referenced local files to repo-relative paths. */
function collectAssets(doc, absPath, root) {
  const pageDir = path.dirname(absPath)
  const targets = []
  for (const img of doc.getImages?.() || []) {
    const target = String(img.target ?? '').trim()
    const dir = String(img.imagesdir ?? '').trim()
    const relativeDir = dir && !dir.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(dir)
    targets.push(relativeDir ? `${dir}/${target}` : target)
  }
  for (const link of doc.getLinks?.() || []) {
    targets.push(String(link ?? '').trim())
  }
  for (const block of doc.findBy((b) => b.getContext() === 'video' || b.getContext() === 'audio')) {
    targets.push(String(block.getAttribute?.('target') ?? '').trim())
  }

  const seen = new Set()
  for (const target of targets.filter(Boolean)) {
    if (isExternalOrAbsoluteTarget(target) || ASSET_SKIP_RE.test(target)) continue
    const srcAbs = path.resolve(pageDir, target)
    const rel = relToRoot(srcAbs, root)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) seen.add(rel)
  }
  return [...seen].sort()
}

// ---------------------------------------------------------------------------

/** Asciidoctor attribute set for a conversion; `linkPrefix` maps to `relfileprefix`. */
function baseAttrs(linkPrefix) {
  return {
    icons: 'font',
    ...(linkPrefix ? { relfileprefix: linkPrefix } : {}),
  }
}

/**
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {boolean} hasSyntaxHighlight
 * @param {{ register?: (registry: unknown) => void, attributes?: Record<string, unknown> }} [diagram]
 */
function asciidocCreate(host, hasSyntaxHighlight, diagram) {
  const registry = Extensions.create()
  registerIncludeCollector(registry)
  let diagramRegistered = false

  /**
   * Apply the `diagram` capability (provided by e.g. mkadoc-plugin-kroki).
   * Register its Asciidoctor adapter once, then merge its attributes.
   * @param {Record<string, unknown>} attrs
   * @returns {Record<string, unknown>}
   */
  function applyDiagramService(attrs) {
    if (!diagram) return attrs
    if (!diagramRegistered && typeof diagram.register === 'function') {
      diagram.register(registry)
      diagramRegistered = true
    }
    if (diagram.attributes && typeof diagram.attributes === 'object') {
      return { ...attrs, ...diagram.attributes }
    }
    return attrs
  }

  return {
    name: 'asciidoc',
    kind: 'renderer',
    extensions: ['.adoc', '.asciidoc'],

    /**
     * @param {string} sourceText
     * @param {string} absPath absolute source file path (base dir for includes)
     * @returns {Promise<import('@mkadoc/plugin-host').SourceMeta>}
     */
    async extractMeta(sourceText, absPath) {
      const doc = await load(sourceText, {
        safe: 'unsafe',
        standalone: false,
        base_dir: absPath ? path.dirname(absPath) : undefined,
      })
      const navLabel = String(doc.getAttribute?.('nav_label') || '').trim()
      const title = String(doc.getDoctitle?.() || doc.getAttribute?.('doctitle') || '').trim()
      return { title, navLabel }
    },

    /**
     * @param {import('@mkadoc/plugin-host').RenderInput} input
     * @returns {Promise<import('@mkadoc/plugin-host').RenderOutput>}
     */
    async render({ sourceText, absPath, baseDir }) {
      // Icons default: the bundled theme ships Font Awesome glyph rules, so
      // admonition/icon markup renders as font classes on every conversion.
      let attrs = { icons: 'font' }
      if (hasSyntaxHighlight) {
        attrs['source-highlighter'] = 'mkadoc-syntax'
      }
      attrs = applyDiagramService(attrs)

      const { result, includes } = await withIncludeCollector(
        { root: host.root, baseDir },
        async () => {
          const doc = await load(sourceText, {
            safe: 'unsafe',
            base_dir: baseDir,
            standalone: true,
            extension_registry: registry,
            attributes: attrs,
            catalog_assets: true,
          })
          const converted = String(await doc.convert())
          return {
            converted,
            title: String(doc.getDoctitle?.() || '').trim(),
            lang: String(doc.getAttribute?.('lang') || 'en'),
            assets: collectAssets(doc, absPath, host.root),
          }
        },
      )

      return {
        html: extractBody(result.converted),
        title: result.title,
        lang: result.lang,
        bodyClass: 'article',
        head: extractHeadMeta(result.converted),
        assets: result.assets,
        includes,
      }
    },

    /**
     * @param {import('@mkadoc/plugin-host').RenderInput} input
     * @returns {Promise<string>}
     */
    async renderFragment({ sourceText, baseDir, linkPrefix }) {
      let attrs = baseAttrs(linkPrefix)
      if (hasSyntaxHighlight) {
        attrs['source-highlighter'] = 'mkadoc-syntax'
      }
      attrs = applyDiagramService(attrs)
      const doc = await load(sourceText, {
        safe: 'unsafe',
        base_dir: baseDir,
        standalone: false,
        extension_registry: registry,
        attributes: attrs,
      })
      return String(await doc.convert())
    },

    /**
     * Parse a nav fragment and return its first link's resolved href + label.
     * @param {import('@mkadoc/plugin-host').RenderInput} input
     * @returns {Promise<{ href: string, label: string } | null>}
     */
    async extractFirstLink({ sourceText, baseDir, linkPrefix }) {
      const doc = await load(sourceText, {
        safe: 'unsafe',
        base_dir: baseDir,
        standalone: false,
        attributes: baseAttrs(linkPrefix),
      })
      for (const block of doc.findBy?.(() => true) || []) {
        const anchor = parse(String(block.getText?.() || '')).querySelector('a')
        if (anchor) {
          return { href: anchor.getAttribute('href') ?? '', label: anchor.text.trim() }
        }
      }
      return null
    },
  }
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function asciidocRenderer(rawOptions = {}, host) {
  parsePluginOptions('mkadoc:asciidoc', OptionsSchema, rawOptions)

  return host.plugin(['syntax-highlight?', 'diagram?'], (syntaxHighlight, diagram) => {
    if (syntaxHighlight) registerServiceSyntaxHighlighter(syntaxHighlight)
    return asciidocCreate(host, Boolean(syntaxHighlight), diagram)
  })
}
