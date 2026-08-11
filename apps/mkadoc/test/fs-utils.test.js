import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { copyAssetDirs, relToRoot, sameFileContent, writeIfChanged } from '../src/fs-utils.js'
import { withTempProject } from './helpers/project.js'

describe('fs-utils', () => {
  it('relToRoot normalizes absolute and relative paths', async () => {
    await withTempProject({ 'docs/a.adoc': '= A\n' }, async (root) => {
      assert.equal(relToRoot('docs/a.adoc', root), 'docs/a.adoc')
      assert.equal(relToRoot('./docs/a.adoc', root), 'docs/a.adoc')
      assert.equal(relToRoot(path.join(root, 'docs/a.adoc'), root), 'docs/a.adoc')
    })
  })

  it('writeIfChanged writes once then skips identical content', async () => {
    await withTempProject({}, async (root) => {
      const file = path.join(root, 'out/note.txt')
      assert.equal(writeIfChanged(file, 'one'), true)
      assert.equal(fs.readFileSync(file, 'utf8'), 'one')
      assert.equal(writeIfChanged(file, 'one'), false)
      assert.equal(writeIfChanged(file, 'two'), true)
      assert.equal(fs.readFileSync(file, 'utf8'), 'two')
    })
  })

  it('sameFileContent compares size then bytes', async () => {
    await withTempProject(
      {
        'a.txt': 'hello',
        'b.txt': 'hello',
        'c.txt': 'world',
      },
      async (root) => {
        const a = path.join(root, 'a.txt')
        const b = path.join(root, 'b.txt')
        const c = path.join(root, 'c.txt')
        const missing = path.join(root, 'missing.txt')
        assert.equal(sameFileContent(a, b), true)
        assert.equal(sameFileContent(a, c), false)
        assert.equal(sameFileContent(a, missing), false)
      },
    )
  })

  it('copyAssetDirs copies files and skips unchanged', async () => {
    await withTempProject(
      {
        'from/a.css': 'body{}',
        'from/b.css': 'h1{}',
      },
      async (root) => {
        copyAssetDirs(root, [{ from: 'from', to: 'to' }])
        assert.equal(fs.readFileSync(path.join(root, 'to/a.css'), 'utf8'), 'body{}')
        assert.equal(fs.readFileSync(path.join(root, 'to/b.css'), 'utf8'), 'h1{}')

        const mtime = fs.statSync(path.join(root, 'to/a.css')).mtimeMs
        await new Promise((r) => setTimeout(r, 20))
        copyAssetDirs(root, [{ from: 'from', to: 'to' }])
        assert.equal(fs.statSync(path.join(root, 'to/a.css')).mtimeMs, mtime)

        // Missing source dirs are ignored.
        copyAssetDirs(root, [{ from: 'nope', to: 'to2' }])
        assert.equal(fs.existsSync(path.join(root, 'to2')), true)
        assert.equal(fs.readdirSync(path.join(root, 'to2')).length, 0)
      },
    )
  })
})
