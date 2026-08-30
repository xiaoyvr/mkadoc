import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { pageMeta, resetPageMetaCache } from '../src/meta-cache.js'
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

      const first = await pageMeta(abs, renderer)
      const second = await pageMeta(abs, renderer)
      assert.equal(calls, 1, 'same build parses once')
      assert.deepEqual(first, second)
      assert.deepEqual(first, { title: 'A', navLabel: undefined })
    })
  })

  it('resetPageMetaCache clears between builds', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      let calls = 0
      const renderer = {
        async extractMeta() {
          calls += 1
          return { title: 'A', navLabel: undefined }
        },
      }

      await pageMeta(abs, renderer)
      await pageMeta(abs, renderer)
      resetPageMetaCache()
      await pageMeta(abs, renderer)
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
      const meta = await pageMeta(abs, renderer)
      assert.deepEqual(meta, { title: 'Long Title', navLabel: undefined })
    })
  })
})
