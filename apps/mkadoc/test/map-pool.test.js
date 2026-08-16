import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('build concurrency', () => {
  it('full build with concurrency still writes all pages', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const mode = await build(cfg, { forceFull: true, concurrency: 2 })
      assert.equal(mode, 'full')
      assert.match(
        fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'),
        /MARKER_INDEX_V1/,
      )
      assert.match(
        fs.readFileSync(path.join(root, 'site/docs/guide.html'), 'utf8'),
        /MARKER_GUIDE_V1/,
      )
    })
  })
})
