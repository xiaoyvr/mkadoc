import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check } from '../src/check.js'
import { loadConfig } from '../src/config.js'
import { smokeFixture, withTempProject, yamlConfig } from './helpers/project.js'

describe('check', () => {
  it('returns 1 when source directory is missing', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - missing-docs
output: site
plugins: {}
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(await check(cfg), 1)
      },
    )
  })

  it('returns 0 when nav file is missing (auto nav fallback)', async () => {
    await withTempProject(
      {
        ...smokeFixture(),
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(await check(cfg), 0)
      },
    )
  })

  it('returns 0 when nav plugin finds a valid _nav.adoc', async () => {
    await withTempProject(
      smokeFixture({
        'docs/_nav.adoc': `* xref:index.adoc[Home]
`,
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(await check(cfg), 0)
      },
    )
  })

  it('disposes plugins after running their checks', async () => {
    await withTempProject(
      {
        ...smokeFixture(),
        'plugins/dispose-check/package.json': JSON.stringify(
          {
            name: 'dispose-check',
            version: '1.0.0',
            type: 'module',
            main: 'index.js',
            dependencies: {},
          },
          null,
          2,
        ),
        'plugins/dispose-check/index.js': `export default function disposeCheckPlugin(rawOptions = {}, host) {
  return host.plugin([], () => ({
    name: 'dispose-check',
    async dispose() {
      const fs = await import('node:fs')
      fs.writeFileSync(new URL('./disposed.txt', import.meta.url), 'disposed')
    },
  }))
}
`,
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  file:./plugins/dispose-check: {}
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(await check(cfg), 0)
        assert.ok(
          fs.existsSync(path.join(root, '.mkadoc/plugins/dispose-check/disposed.txt')),
          'plugin disposed after check',
        )
      },
    )
  })
})
