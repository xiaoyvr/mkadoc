import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { build } from '../src/build.js'
import { afterPluginsLoaded } from '../src/builtins/shiki.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

after(() => {
  afterPluginsLoaded([])
})

describe('shiki asset href writing', () => {
  it('writes CSS to the path derived from css_href', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: github-light-default
    css_href: /assets/shiki.css
`),
        'docs/index.adoc': `= Smoke Index

[source,bash]
----
echo hello
----
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        assert.match(
          fs.readFileSync(path.join(root, 'site/assets/shiki.css'), 'utf8'),
          /Generated from Shiki/,
        )
        assert.equal(fs.existsSync(path.join(root, 'site/styles/shiki.css')), false)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/assets\/shiki\.css"/)
      },
    )
  })
})
