import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { relToRoot, walkDir, writeIfChanged } from '../src/fs-utils.js'
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

  it('walkDir visits files and respects shouldEnterDir / missing skip', async () => {
    await withTempProject(
      {
        'root/a.txt': 'a',
        'root/sub/b.txt': 'b',
        'root/skip/c.txt': 'c',
      },
      async (tmp) => {
        const seen = []
        walkDir(path.join(tmp, 'root'), {
          shouldEnterDir: (_full, name) => name !== 'skip',
          onFile: (_full, name) => seen.push(name),
        })
        assert.deepEqual(seen.sort(), ['a.txt', 'b.txt'])

        const missing = []
        walkDir(path.join(tmp, 'nope'), {
          onFile: (_full, name) => missing.push(name),
        })
        assert.deepEqual(missing, [])

        assert.throws(
          () =>
            walkDir(path.join(tmp, 'nope'), {
              missing: 'throw',
              onFile: () => {},
            }),
          /directory not found/,
        )
      },
    )
  })
})
