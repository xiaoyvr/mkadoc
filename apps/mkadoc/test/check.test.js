import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check } from '../src/check.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

describe('check', () => {
  it('returns 1 when source directory is missing', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`source: missing-docs
output: site
plugins: {}
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(await check(cfg), 1)
      },
    )
  })

  it('returns 1 when nav plugin points at a missing file', async () => {
    await withTempProject(
      {
        ...smokeFixture(),
        'mkadoc.adoc': literateConfig(`source: docs
output: site
plugins:
  mkadoc:nav:
    nav: docs/_missing-nav.adoc
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(await check(cfg), 1)
      },
    )
  })

  it('returns 0 when nav plugin finds a valid _nav.adoc', async () => {
    await withTempProject(
      smokeFixture({
        'docs/_nav.adoc': `= Nav

* <<index.adoc,Home>>
`,
        'mkadoc.adoc': literateConfig(`source: docs
output: site
plugins:
  mkadoc:nav:
    nav: docs/_nav.adoc
`),
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(await check(cfg), 0)
      },
    )
  })
})
