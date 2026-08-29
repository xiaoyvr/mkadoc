import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import navPlugin from '../src/builtins/nav.js'
import shikiPlugin from '../src/builtins/shiki.js'
import { createHosts } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('plugin-owned option validation', () => {
  it('nav factory rejects unknown options', () => {
    assert.throws(() => navPlugin({ thme: 'x' }), /mkadoc:nav:.*Unrecognized key: "thme"/)
  })

  it('shiki factory rejects unknown options', () => {
    assert.throws(() => shikiPlugin({ thme: 'nord' }), /mkadoc:shiki:.*Unrecognized key: "thme"/)
  })

  it('loadPlugins surfaces plugin option errors', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { plugin } = createHosts({
        root,
        sources: [{ path: 'docs', mount: '/docs', title: 'Docs' }],
        output: 'site',
        plugins: {},
      })
      await assert.rejects(
        () => loadPlugins({ 'mkadoc:nav': { bogus: true } }, plugin),
        /mkadoc:nav:.*Unrecognized key: "bogus"/,
      )
    })
  })
})
