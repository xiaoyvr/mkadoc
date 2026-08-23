import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { build } from '../src/build.js'
import { afterPluginsLoaded } from '../src/builtins/shiki.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

after(() => {
  afterPluginsLoaded([])
})

describe('shiki asset writing', () => {
  it('writes CSS to /styles/shiki.css and links it', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: github-light-default
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

        const docinfo = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8'),
        )
        assert.ok(docinfo.querySelector('link[href="/styles/shiki.css"]'))
      },
    )
  })
})
