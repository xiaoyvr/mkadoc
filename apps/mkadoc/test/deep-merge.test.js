import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deepMerge } from '../src/config.js'

describe('deepMerge', () => {
  it('replaces arrays from next instead of concatenating', () => {
    const base = { assets: [{ from: 'a', to: 'b' }], tags: ['x'] }
    const next = { assets: [{ from: 'c', to: 'd' }], tags: ['y', 'z'] }

    assert.deepEqual(deepMerge(base, next), {
      assets: [{ from: 'c', to: 'd' }],
      tags: ['y', 'z'],
    })
  })

  it('returns next when next is not a plain object', () => {
    assert.equal(deepMerge({ a: 1 }, null), null)
    assert.equal(deepMerge({ a: 1 }, undefined), undefined)
    assert.deepEqual(deepMerge({ a: 1 }, [1, 2]), [1, 2])
    assert.equal(deepMerge({ a: 1 }, 5), 5)
  })

  it('does not mutate the base object', () => {
    const base = { serve: { port: 8000 }, keep: true }
    const next = { serve: { port: 9000 } }
    const out = deepMerge(base, next)

    assert.equal(base.serve.port, 8000)
    assert.equal(out.serve.port, 9000)
    assert.notEqual(out, base)
    assert.notEqual(out.serve, base.serve)
  })
})
