import path from 'node:path'
import MarkdownIt from 'markdown-it'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { relToRoot } from '../fs-utils.js'
import { parsePluginOptions } from '../plugin/options.js'

const OptionsSchema = z
  .object({
    html: z.boolean().default(false),
  })
  .strict()

const ASSET_SKIP_RE = /\.(?:html?|md|markdown)$/i

/** Split `---` YAML frontmatter from a Markdown body. */
function splitFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(text)
  if (!m) return { frontmatter: {}, body: text, hasFrontmatter: false }
  let frontmatter = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed
  } catch {
    // unparseable frontmatter — treat as body
    return { frontmatter: {}, body: text, hasFrontmatter: false }
  }
  return { frontmatter, body: text.slice(m[0].length), hasFrontmatter: true }
}

/**
 * First h1 of a Markdown body — ATX (`# T`) or setext (`T\n===`) — used as
 * the title fallback when frontmatter has no `title`.
 */
function firstHeading(body) {
  const atx = /^#\s+(.+)$/m.exec(body)
  if (atx) return atx[1].trim()
  const setext = /^(.+)\n=+\s*$/m.exec(body)
  return setext ? setext[1].trim() : ''
}

function isExternalOrAbsoluteTarget(target) {
  if (target.startsWith('#') || target.startsWith('/')) return true
  return /^[a-z][a-z0-9+.-]*:/i.test(target)
}

/** Collect local image/link targets from markdown-it inline tokens. */
function collectAssets(tokens, absPath, root) {
  const pageDir = path.dirname(absPath)
  const seen = new Set()

  const add = (target) => {
    const t = String(target ?? '').trim()
    if (!t || isExternalOrAbsoluteTarget(t) || ASSET_SKIP_RE.test(t)) return
    const abs = path.resolve(pageDir, t)
    const rel = relToRoot(abs, root)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) seen.add(rel)
  }

  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue
    for (const child of token.children) {
      if (child.type === 'image') add(child.attrGet('src'))
      else if (child.type === 'link_open') add(child.attrGet('href'))
    }
  }
  return [...seen].sort()
}

/**
 * @param {import('../plugin/contract.js').MkadocPluginHost} host
 * @param {boolean} allowHtml
 */
function createMarkdownIt(host, allowHtml) {
  const md = new MarkdownIt({ html: allowHtml })
  const hl = host.getService('syntax-highlight')
  if (hl) {
    md.set({
      highlight: (code, lang) => hl.highlight(String(code), String(lang || '')),
    })
  }
  return md
}

/** @type {import('../plugin/contract.js').MkadocPluginFactory} */
export default function markdownRenderer(rawOptions = {}, host) {
  const { html } = parsePluginOptions('mkadoc:markdown', OptionsSchema, rawOptions)

  return {
    name: 'markdown',
    kind: 'renderer',
    extensions: ['.md', '.markdown'],

    /**
     * @param {string} sourceText
     * @returns {import('../plugin/contract.js').SourceMeta}
     */
    extractMeta(sourceText) {
      const { frontmatter, body } = splitFrontmatter(sourceText)
      const navLabel = String(frontmatter.nav_label ?? '').trim()
      const title = String(frontmatter.title ?? '').trim() || firstHeading(body)
      return { title, navLabel: navLabel || undefined }
    },

    /**
     * @param {import('../plugin/contract.js').RenderInput} input
     * @returns {import('../plugin/contract.js').RenderOutput}
     */
    render({ sourceText, absPath, attributes: _attributes }) {
      const { frontmatter, body } = splitFrontmatter(sourceText)
      const md = createMarkdownIt(host, html)
      const tokens = md.parse(body, {})
      const htmlBody = md.renderer.render(tokens, md.options, {})

      return {
        html: htmlBody,
        title: String(frontmatter.title ?? '').trim() || firstHeading(body),
        lang: String(frontmatter.lang ?? 'en'),
        bodyClass: 'article',
        head: '',
        assets: collectAssets(tokens, absPath, host.root),
        includes: [],
      }
    },

    /**
     * @param {import('../plugin/contract.js').RenderInput} input
     * @returns {string}
     */
    renderFragment({ sourceText }) {
      const { body } = splitFrontmatter(sourceText)
      return createMarkdownIt(host, html).render(body)
    },
  }
}
