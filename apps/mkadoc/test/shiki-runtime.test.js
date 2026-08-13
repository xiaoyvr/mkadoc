import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { SyntaxHighlighter } from '@asciidoctor/core'
import { build } from '../src/build.js'
import { afterPluginsLoaded } from '../src/builtins/shiki.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

after(() => {
  afterPluginsLoaded([])
})

function shikiFixture(theme = 'github-light-default') {
  return smokeFixture({
    'mkadoc.adoc': literateConfig(`source: docs
output: site
cache: .cache/asciidoctor
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

describe('shiki process-global runtime', () => {
  it('recreates highlighter on theme change without restart', async () => {
    await withTempProject(shikiFixture('github-light-default'), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })
      const css1 = fs.readFileSync(path.join(root, 'site/styles/shiki.css'), 'utf8')
      const html1 = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')
      assert.match(html1, /pre.*shiki|class="shiki"/)

      fs.writeFileSync(
        path.join(root, 'mkadoc.adoc'),
        literateConfig(`source: docs
output: site
cache: .cache/asciidoctor
plugins:
  mkadoc:shiki:
    theme: nord
`),
      )
      const cfg2 = await loadConfig('mkadoc.adoc', root)
      await build(cfg2, { forceFull: true })
      const css2 = fs.readFileSync(path.join(root, 'site/styles/shiki.css'), 'utf8')
      assert.notEqual(css1, css2)
      assert.match(css2, /nord/i)
      assert.match(fs.readFileSync(path.join(root, 'site/index.html'), 'utf8'), /shiki/)
    })
  })

  it('disposes runtime when shiki is removed from config', async () => {
    await withTempProject(shikiFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      fs.writeFileSync(
        path.join(root, 'mkadoc.adoc'),
        literateConfig(`source: docs
output: site
cache: .cache/asciidoctor
plugins: {}
`),
      )
      const cfg2 = await loadConfig('mkadoc.adoc', root)
      await build(cfg2, { forceFull: true })

      const Adapter = SyntaxHighlighter.for('shiki')
      assert.ok(Adapter)
      const instance = new Adapter('shiki')
      assert.equal(instance.name, 'shiki')
      assert.throws(() => instance.highlight(), /not enabled/)
    })
  })

  it('can re-enable shiki after dispose without process restart', async () => {
    await withTempProject(shikiFixture(), async (root) => {
      await build(await loadConfig('mkadoc.adoc', root), { forceFull: true })

      fs.writeFileSync(
        path.join(root, 'mkadoc.adoc'),
        literateConfig(`source: docs
output: site
cache: .cache/asciidoctor
plugins: {}
`),
      )
      await build(await loadConfig('mkadoc.adoc', root), { forceFull: true })

      fs.writeFileSync(
        path.join(root, 'mkadoc.adoc'),
        literateConfig(`source: docs
output: site
cache: .cache/asciidoctor
plugins:
  mkadoc:shiki:
    theme: github-light-default
`),
      )
      await build(await loadConfig('mkadoc.adoc', root), { forceFull: true })
      const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')
      assert.match(html, /echo[\s\S]*hello/)
      assert.match(html, /shiki/)
    })
  })
})
