import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { pageMeta } from '../src/meta-cache.js'
import { sleep, withTempProject } from './helpers/project.js'

describe('pageMeta cache', () => {
  it('memoizes by path + mtime: one parse per unchanged file', async () => {
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
      assert.equal(calls, 1, 'unchanged file parses once')
      assert.deepEqual(first, second)
      assert.deepEqual(first, { title: 'A', navLabel: undefined })
    })
  })

  it('invalidates when the file changes', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      const abs = path.join(root, 'docs/a.adoc')
      let title = 'A'
      const renderer = {
        async extractMeta() {
          return { title, navLabel: undefined }
        },
      }

      assert.equal((await pageMeta(abs, renderer)).title, 'A')
      title = 'B'
      fs.writeFileSync(abs, '= B\n')
      await sleep(20) // mtime granularity
      assert.equal((await pageMeta(abs, renderer)).title, 'B', 'edited file re-parses')
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
