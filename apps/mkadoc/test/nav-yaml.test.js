import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { loadDependencyGraph } from '../src/deps.js'
import { createHosts } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { parseHtml } from './helpers/html.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

function sidebarOf(root) {
  const html = fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8')
  return parseHtml(html).querySelector('#mkadoc-articles')
}

function sidebarLinks(root) {
  return sidebarOf(root)
    .querySelectorAll('a')
    .map((a) => [a.text.trim(), a.getAttribute('href')])
}

describe('_nav.yaml (declarative nav)', () => {
  it('derives labels from page titles', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/guide.md': '# Guide\n',
        'docs/_nav.yaml': '- page: index\n- page: guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.deepEqual(sidebarLinks(root), [
          ['Home', '/docs/index.html'],
          ['Guide', '/docs/guide.html'],
        ])
      },
    )
  })

  it('page title wins over the optional label', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Real Title\n',
        'docs/_nav.yaml': '- page: index\n  label: Fallback\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.deepEqual(sidebarLinks(root), [['Real Title', '/docs/index.html']])
      },
    )
  })

  it('page label uses the title, not the :tab: attribute', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.adoc': '= Index\n',
        'docs/guide.adoc': '= Long Guide Title\n:tab: Short\n',
        'docs/_nav.yaml': '- page: guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        // `:tab:` is a source-level label; a page's sidebar label is its title.
        assert.deepEqual(sidebarLinks(root), [['Long Guide Title', '/docs/guide.html']])
      },
    )
  })

  it('uses the optional label when the page has no title', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/guide.md': 'Just a paragraph, no heading.\n',
        'docs/_nav.yaml': '- page: guide\n  label: Guide Manual\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.deepEqual(sidebarLinks(root), [['Guide Manual', '/docs/guide.html']])
      },
    )
  })

  it('supports a clickable parent (page + children)', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/guide.md': '# Guide\n',
        'docs/guide/setup.md': '# Setup\n',
        'docs/_nav.yaml': '- page: guide\n  children:\n    - page: guide/setup\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const sidebar = sidebarOf(root)
        assert.deepEqual(
          sidebar.querySelectorAll('a').map((a) => [a.text.trim(), a.getAttribute('href')]),
          [
            ['Guide', '/docs/guide.html'],
            ['Setup', '/docs/guide/setup.html'],
          ],
        )
        // the parent link and its nested list sit under the same <li>
        assert.ok(sidebar.querySelector('li:has(> p > a) li'))
      },
    )
  })

  it('supports a non-clickable section header (label + children)', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/plugins.md': '# Plugins\n',
        'docs/_nav.yaml': '- label: Reference\n  children:\n    - page: plugins\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const sidebar = sidebarOf(root)
        assert.ok(sidebar.text.includes('Reference'))
        assert.deepEqual(sidebarLinks(root), [['Plugins', '/docs/plugins.html']])
      },
    )
  })

  it('supports raw href entries (external links)', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': '- label: GitHub\n  href: https://github.com/xiaoyvr/mkadoc\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.deepEqual(sidebarLinks(root), [['GitHub', 'https://github.com/xiaoyvr/mkadoc']])
      },
    )
  })

  it('_nav.adoc takes precedence over _nav.yaml', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.adoc': '= Home\n',
        'docs/_nav.adoc': '* xref:index.adoc[FromAdoc]\n',
        'docs/_nav.yaml': '- page: index\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.ok(sidebarOf(root).text.includes('FromAdoc'))
      },
    )
  })

  it('rejects an item with no page/href/children', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': '- label: Broken\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await assert.rejects(() => build(cfg, { forceFull: true }), /invalid _nav\.yaml/)
      },
    )
  })

  it('rejects href without a label', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': '- href: https://example.com\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await assert.rejects(() => build(cfg, { forceFull: true }), /invalid _nav\.yaml/)
      },
    )
  })

  it('rejects an item with both page and href', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': '- page: index\n  href: https://example.com\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await assert.rejects(() => build(cfg, { forceFull: true }), /invalid _nav\.yaml/)
      },
    )
  })

  it('check reports an invalid _nav.yaml as a failure', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': '- label: Broken\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        const { plugin } = createHosts(cfg, { deps: loadDependencyGraph(root) })
        const runner = await loadPlugins(cfg.plugins, plugin)
        const results = await runner.check()
        const nav = results.find((r) => r.locator === 'mkadoc:nav')
        assert.equal(nav.ok, false)
        assert.match(nav.message, /_nav\.yaml invalid/)
      },
    )
  })
})
