import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('auto-nav (convention-based, no _nav file)', () => {
  it('builds a tree from folders + index pages, in file-name order', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.adoc': '= Home\n',
        'docs/01-intro.adoc': '= Introduction\n',
        'docs/02-guide/index.adoc': '= Guide Section\n',
        'docs/02-guide/01-setup.adoc': '= Setup\n',
        'docs/02-guide/02-usage.adoc': '= Usage\n',
        'docs/10-reference/01-api.adoc': '= API Reference\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })

        const html = fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8')
        const page = parseHtml(html)
        const sidebar = page.querySelector('#mkadoc-articles')

        // source bar = the source root's index page
        const tab = page.querySelector('a.mkadoc-source')
        assert.equal(tab.text.trim(), 'Home')
        assert.equal(tab.getAttribute('href'), '/docs/index.html')

        const s = sidebar.toString()
        // root index page is the first sidebar item
        assert.ok(s.includes('href="/docs/index.html">Home</a>'))
        // file-name order: 01 < 02 < 10
        assert.ok(s.indexOf('Introduction') < s.indexOf('Guide Section'))
        assert.ok(s.indexOf('Guide Section') < s.indexOf('10-reference'))
        // folder with index → clickable parent + children
        assert.ok(s.includes('href="/docs/02-guide/index.html">Guide Section</a>'))
        assert.ok(s.includes('>Setup</a>'))
        assert.ok(s.includes('>Usage</a>'))
        // folder without index → non-clickable, label = folder basename
        assert.ok(s.includes('<p>10-reference</p>'))
        assert.ok(s.includes('href="/docs/10-reference/01-api.html">API Reference</a>'))
      },
    )
  })

  it('uses page labels (:nav_label: → title) for leaves and index pages', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.adoc': '= Home\n',
        'docs/guide.adoc': '= Long Guide Title\n:nav_label: Guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const html = fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8')
        assert.ok(html.includes('>Guide</a>'))
        assert.ok(!html.includes('>Long Guide Title</a>'))
      },
    )
  })
})
