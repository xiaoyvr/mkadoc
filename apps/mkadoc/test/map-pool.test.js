import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build, defaultConvertConcurrency, mapPool } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('mapPool', () => {
  it('runs all items and respects the concurrency limit', async () => {
    let inflight = 0
    let maxInflight = 0
    const seen = []

    await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 20))
      seen.push(n)
      inflight -= 1
    })

    assert.deepEqual(
      seen.sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    )
    assert.ok(maxInflight <= 2)
    assert.ok(maxInflight >= 2)
  })

  it('defaultConvertConcurrency is between 1 and 4', () => {
    const n = defaultConvertConcurrency()
    assert.ok(n >= 1 && n <= 4)
  })
})

describe('build concurrency', () => {
  it('full build with concurrency still writes all pages', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yml', root)
      const mode = await build(cfg, { forceFull: true, concurrency: 2 })
      assert.equal(mode, 'full')
      assert.match(fs.readFileSync(path.join(root, 'site/index.html'), 'utf8'), /MARKER_INDEX_V1/)
      assert.match(fs.readFileSync(path.join(root, 'site/guide.html'), 'utf8'), /MARKER_GUIDE_V1/)
    })
  })
})
