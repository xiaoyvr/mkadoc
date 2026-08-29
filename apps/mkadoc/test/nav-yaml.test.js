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

describe('_nav.yaml (declarative nav)', () => {
  it('renders a flat page list with normalized .html hrefs', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/guide.md': '# Guide\n',
        'docs/_nav.yaml': '- label: Home\n  page: index\n- label: Guide\n  page: guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const sidebar = sidebarOf(root)
        const links = sidebar.querySelectorAll('a')
        assert.deepEqual(
          links.map((a) => [a.text.trim(), a.getAttribute('href')]),
          [
            ['Home', '/docs/index.html'],
            ['Guide', '/docs/guide.html'],
          ],
        )
      },
    )
  })

  it('renders nested children as a section with a sub-list', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.md': '# Home\n',
        'docs/_nav.yaml': `- label: Overview\n  page: index\n- label: Reference\n  children:\n    - label: Plugins\n      page: plugins\n    - label: Chrome\n      page: chrome-design\n`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const sidebar = sidebarOf(root)
        assert.ok(sidebar.text.includes('Overview'))
        assert.ok(sidebar.text.includes('Reference'))
        const nested = sidebar.querySelectorAll('li ul a')
        assert.deepEqual(
          nested.map((a) => [a.text.trim(), a.getAttribute('href')]),
          [
            ['Plugins', '/docs/plugins.html'],
            ['Chrome', '/docs/chrome-design.html'],
          ],
        )
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
        const link = sidebarOf(root).querySelector('a')
        assert.equal(link.text.trim(), 'GitHub')
        assert.equal(link.getAttribute('href'), 'https://github.com/xiaoyvr/mkadoc')
      },
    )
  })

  it('_nav.adoc takes precedence over _nav.yaml', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: site\nplugins:\n  mkadoc:nav: {}\n`),
        'docs/index.adoc': '= Home\n',
        'docs/_nav.adoc': '* xref:index.adoc[FromAdoc]\n',
        'docs/_nav.yaml': '- label: FromYaml\n  page: index\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const sidebar = sidebarOf(root)
        assert.ok(sidebar.text.includes('FromAdoc'))
        assert.ok(!sidebar.text.includes('FromYaml'))
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
