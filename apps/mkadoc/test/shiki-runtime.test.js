import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { smokeFixture, withTempProject, yamlConfig } from './helpers/project.js'

function shikiFixture(theme = 'github-light-default') {
  return smokeFixture({
    'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: ${theme}
`),
    'docs/index.adoc': `= Smoke Index

[source,bash]
----
echo hello
----
`,
  })
}

function noShikiConfig() {
  return yamlConfig(`sources:
  - docs
output: site
plugins: {}
`)
}

describe('shiki syntax-highlight service', () => {
  it('recreates highlighter on theme change without restart', async () => {
    await withTempProject(shikiFixture('github-light-default'), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      await build(cfg, { forceFull: true })
      const css1 = fs.readFileSync(path.join(root, 'site/styles/shiki.css'), 'utf8')
      const html1 = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
      assert.ok(html1.querySelector('.shiki'))
      assert.ok(html1.querySelector('link[href="/styles/shiki.css"]'))

      fs.writeFileSync(
        path.join(root, 'mkadoc.yaml'),
        yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: nord
`),
      )
      const cfg2 = await loadConfig('mkadoc.yaml', root)
      await build(cfg2, { forceFull: true })
      const css2 = fs.readFileSync(path.join(root, 'site/styles/shiki.css'), 'utf8')
      assert.notEqual(css1, css2)
      assert.ok(
        parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8')).querySelector(
          '.shiki',
        ),
      )
    })
  })

  it('falls back to a plain listing when shiki is removed from config', async () => {
    await withTempProject(shikiFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      await build(cfg, { forceFull: true })

      fs.writeFileSync(path.join(root, 'mkadoc.yaml'), noShikiConfig())
      const cfg2 = await loadConfig('mkadoc.yaml', root)
      await build(cfg2, { forceFull: true })

      const html = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
      assert.equal(html.querySelector('.shiki'), null)
      assert.ok(html.text.includes('echo'))
    })
  })

  it('can re-enable shiki after removal without process restart', async () => {
    await withTempProject(shikiFixture(), async (root) => {
      await build(await loadConfig('mkadoc.yaml', root), { forceFull: true })

      fs.writeFileSync(path.join(root, 'mkadoc.yaml'), noShikiConfig())
      await build(await loadConfig('mkadoc.yaml', root), { forceFull: true })

      fs.writeFileSync(
        path.join(root, 'mkadoc.yaml'),
        yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: github-light-default
`),
      )
      await build(await loadConfig('mkadoc.yaml', root), { forceFull: true })
      const html = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
      assert.ok(html.querySelector('.shiki'))
      assert.ok(html.text.includes('echo'))
      assert.ok(html.text.includes('hello'))
    })
  })
})
