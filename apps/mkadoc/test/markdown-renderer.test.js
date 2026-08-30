import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('markdown renderer', () => {
  it('renders Markdown pages alongside AsciiDoc with chrome + title', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:topbar: {}
  mkadoc:nav: {}
`),
        'docs/index.md': `---
title: Markdown Home
---

# Hello Markdown

Some *emphasis* and a [link](https://example.com).
`,
        'docs/guide.adoc': `= AsciiDoc Guide

Mixed formats.
`,
        'docs/_nav.yaml': '- page: index\n- page: guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })

        const md = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.equal(md.querySelector('title')?.text.trim(), 'Markdown Home')
        assert.equal(md.querySelector('h1')?.text.trim(), 'Hello Markdown')
        assert.ok(md.querySelector('#mkadoc-topbar'), 'markdown page gets shared chrome')
        assert.equal(
          md.querySelector('a.mkadoc-source')?.text.trim(),
          'Markdown Home',
          'source-bar label derives from the first nav item',
        )
        // renderer-agnostic doc title: declared by the renderer, carried by
        // the wrapper — chrome never parses renderer body markup
        assert.equal(md.querySelector('body')?.getAttribute('data-doc-title'), 'Markdown Home')

        const adoc = parseHtml(fs.readFileSync(path.join(root, 'site/docs/guide.html'), 'utf8'))
        assert.ok(adoc.querySelector('#header'), 'asciidoc page keeps its own header')
        assert.ok(adoc.querySelector('#mkadoc-topbar'), 'asciidoc page gets shared chrome')
        assert.equal(adoc.querySelector('body')?.getAttribute('data-doc-title'), 'AsciiDoc Guide')

        // topbar swap logic reads the core-owned attribute, not #header h1
        const topbarJs = fs.readFileSync(path.join(root, 'site/styles/topbar.js'), 'utf8')
        assert.ok(topbarJs.includes('data-doc-title'))
        assert.ok(!topbarJs.includes('#header h1'))
      },
    )
  })

  it('derives the title from a setext h1 when there is no frontmatter', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
`),
        'docs/index.md': `Setext Title
============

Body paragraph.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const html = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.equal(html.querySelector('title')?.text.trim(), 'Setext Title')
        assert.equal(html.querySelector('h1')?.text.trim(), 'Setext Title')
      },
    )
  })

  it('ignores a setext h2 (---) as the document title', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
`),
        'docs/index.md': `Sub Section
-----------

Body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const html = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.equal(html.querySelector('title')?.text.trim(), '')
        assert.equal(html.querySelector('h2')?.text.trim(), 'Sub Section')
      },
    )
  })

  it('highlights fenced code blocks through the syntax-highlight service', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: github-light-default
`),
        'docs/index.md': `# Code

\`\`\`bash
echo hello
\`\`\`
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const html = fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8')
        assert.ok(html.includes('echo'))
        // shiki inline spans carry token colors
        assert.match(html, /style="color:/)
      },
    )
  })
})
