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
description: A markdown source
---

# Hello Markdown

Some *emphasis* and a [link](https://example.com).
`,
        'docs/guide.adoc': `= AsciiDoc Guide

Mixed formats.
`,
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
          'tab title derives from frontmatter',
        )

        const adoc = parseHtml(fs.readFileSync(path.join(root, 'site/docs/guide.html'), 'utf8'))
        assert.ok(adoc.querySelector('#header'), 'asciidoc page keeps its own header')
        assert.ok(adoc.querySelector('#mkadoc-topbar'), 'asciidoc page gets shared chrome')
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
