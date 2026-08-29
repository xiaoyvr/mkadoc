import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { smokeFixture, withTempProject, yamlConfig } from './helpers/project.js'

describe('shiki asset writing', () => {
  it('writes CSS to /styles/shiki.css and links it', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.yaml': yamlConfig(`sources:
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
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })

        const docinfo = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.ok(docinfo.querySelector('link[href="/styles/shiki.css"]'))
      },
    )
  })
})
