import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mountFromSourcePath, pageToOutRel } from '../src/sources.js'

describe('mountFromSourcePath', () => {
  it('maps source paths to mounts verbatim', () => {
    assert.equal(mountFromSourcePath('docs'), '/docs')
    assert.equal(mountFromSourcePath('apps/mkadoc/docs'), '/apps/mkadoc/docs')
    assert.equal(mountFromSourcePath('modules/home/docs'), '/modules/home/docs')
    assert.equal(mountFromSourcePath('notes'), '/notes')
  })
})

describe('pageToOutRel', () => {
  it('maps repo-relative pages to mount-relative .html paths', () => {
    const source = { path: 'docs', mount: '/docs' }
    assert.equal(pageToOutRel(source, 'docs/index.adoc'), 'docs/index.html')
    assert.equal(pageToOutRel(source, 'docs/guide.md'), 'docs/guide.html')
    assert.equal(pageToOutRel(source, 'docs/sub/deep.adoc'), 'docs/sub/deep.html')
  })

  it('maps nested source paths under their mount', () => {
    const source = { path: 'apps/mkadoc/docs', mount: '/apps/mkadoc/docs' }
    assert.equal(pageToOutRel(source, 'apps/mkadoc/docs/guide.adoc'), 'apps/mkadoc/docs/guide.html')
  })

  it('rejects pages outside the source', () => {
    const source = { path: 'docs', mount: '/docs' }
    assert.throws(() => pageToOutRel(source, 'other/guide.adoc'), /not under source/)
  })
})
