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
 * Build a markdown-it instance wired to the (optional) `syntax-highlight`
 * capability. No service lookup: the value comes from the injected deps.
 * @param {boolean} allowHtml
 * @param {{ highlight: (code: string, lang: string) => string }} [syntaxHighlight]
 */
function createMarkdownIt(allowHtml, syntaxHighlight) {
  const md = new MarkdownIt({ html: allowHtml })
  if (syntaxHighlight) {
    md.set({
      highlight: (code, lang) => syntaxHighlight.highlight(String(code), String(lang || '')),
    })
  }
  return md
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function markdownRenderer(rawOptions = {}, host) {
  const { html } = parsePluginOptions('mkadoc:markdown', OptionsSchema, rawOptions)

  return host.plugin(['syntax-highlight?'], (syntaxHighlight) => ({
    name: 'markdown',
    kind: 'renderer',
    extensions: ['.md', '.markdown'],

    /**
     * @param {string} sourceText
     * @returns {import('@mkadoc/plugin-host').SourceMeta}
     */
    extractMeta(sourceText) {
      const { frontmatter, body } = splitFrontmatter(sourceText)
      const navLabel = String(frontmatter.nav_label ?? '').trim()
      const title = String(frontmatter.title ?? '').trim() || firstHeading(body)
      return { title, navLabel: navLabel || undefined }
    },

    /**
     * @param {import('@mkadoc/plugin-host').RenderInput} input
     * @returns {import('@mkadoc/plugin-host').RenderOutput}
     */
    render({ sourceText, absPath }) {
      const { frontmatter, body } = splitFrontmatter(sourceText)
      const md = createMarkdownIt(html, syntaxHighlight)
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
     * @param {import('@mkadoc/plugin-host').RenderInput} input
     * @returns {string}
     */
    renderFragment({ sourceText, baseDir: _baseDir, linkPrefix: _linkPrefix }) {
      const { body } = splitFrontmatter(sourceText)
      // baseDir/linkPrefix: markdown has no includes and no fragment
      // consumers yet (_nav.md doesn't exist) — accepted for contract shape.
      return createMarkdownIt(html, syntaxHighlight).render(body)
    },
  }))
}
