import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPageMetaCache } from '../src/meta-cache.js'
import { withTempProject } from './helpers/project.js'

describe('pageMeta cache (per build)', () => {
  it('memoizes per path: one parse per page within a build', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      let calls = 0
      const renderer = {
        async extractMeta() {
          calls += 1
          return { title: 'A', navLabel: undefined }
        },
      }
      const cache = createPageMetaCache()

      const first = await cache.get(abs, renderer)
      const second = await cache.get(abs, renderer)
      assert.equal(calls, 1, 'same build parses once')
      assert.deepEqual(first, second)
      assert.deepEqual(first, { title: 'A', navLabel: undefined })
    })
  })

  it('clear() between builds re-parses', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      let calls = 0
      const renderer = {
        async extractMeta() {
          calls += 1
          return { title: 'A', navLabel: undefined }
        },
      }
      const cache = createPageMetaCache()

      await cache.get(abs, renderer)
      await cache.get(abs, renderer)
      cache.clear()
      await cache.get(abs, renderer)
      assert.equal(calls, 2, 'a fresh build re-parses')
    })
  })

  it('normalizes title and navLabel', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      const renderer = {
        async extractMeta() {
          return { title: '  Long Title  ', navLabel: '  ' }
        },
      }
      const cache = createPageMetaCache()
      const meta = await cache.get(abs, renderer)
      assert.deepEqual(meta, { title: 'Long Title', navLabel: undefined })
    })
  })

  it('independent caches do not share entries (per-session)', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      let calls = 0
      const renderer = {
        async extractMeta() {
          calls += 1
          return { title: 'A', navLabel: undefined }
        },
      }

      const one = createPageMetaCache()
      const two = createPageMetaCache()
      await one.get(abs, renderer)
      await two.get(abs, renderer)
      assert.equal(calls, 2, 'each session cache parses independently')
    })
  })
})
