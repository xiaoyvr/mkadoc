import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check } from '../src/check.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

describe('check', () => {
  it('returns 1 when source directory is missing', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - missing-docs
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

  it('returns 0 when nav file is missing (auto nav fallback)', async () => {
    await withTempProject(
      {
        ...smokeFixture(),
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(await check(cfg), 0)
      },
    )
  })

  it('returns 0 when nav plugin finds a valid _nav.adoc', async () => {
    await withTempProject(
      smokeFixture({
        'docs/_nav.adoc': `* xref:index.adoc[Home]
`,
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(await check(cfg), 0)
      },
    )
  })
})
