import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { createSession } from '../src/session.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('nav label staleness', () => {
  it('full rebuild only when a nav-referenced page label changes', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.md': '# Home\n',
        'docs/guide.md': '# Guide\n',
        'docs/_nav.yaml': '- page: index\n- page: guide\n',
      },
      async (root) => {
        // One session across builds: the nav classifier's label caches are
        // session state (warmed by each chrome pass, read by the next build).
        const session = createSession()
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true, session })

        // content-only change → incremental (just that page, chrome untouched)
        fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Guide\n\nMore content.\n')
        assert.equal(await build(cfg, { paths: ['docs/guide.md'], session }), 'incremental')

        // label change → full rebuild (chrome re-baked everywhere)
        fs.writeFileSync(path.join(root, 'docs/guide.md'), '# New Guide\n\nMore content.\n')
        assert.equal(await build(cfg, { paths: ['docs/guide.md'], session }), 'full')
      },
    )
  })
})
