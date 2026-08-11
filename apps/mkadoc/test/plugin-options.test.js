import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import krokiDiagramPlugin from '../src/builtins/kroki-diagram.js'
import navPlugin from '../src/builtins/nav.js'
import shikiPlugin from '../src/builtins/shiki.js'
import { createHost } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('plugin-owned option validation', () => {
  it('nav factory rejects unknown options', () => {
    assert.throws(() => navPlugin({ thme: 'x' }), /mkadoc:nav:.*Unrecognized key: "thme"/)
  })

  it('shiki factory rejects unknown options', () => {
    assert.throws(() => shikiPlugin({ thme: 'nord' }), /mkadoc:shiki:.*Unrecognized key: "thme"/)
  })

  it('kroki factory requires server_url', () => {
    assert.throws(() => krokiDiagramPlugin({}), /mkadoc:kroki-diagram:.*server_url/)
    assert.throws(() => krokiDiagramPlugin({ server_url: '' }), /mkadoc:kroki-diagram:.*server_url/)
  })

  it('kroki factory rejects unknown options', () => {
    assert.throws(
      () => krokiDiagramPlugin({ server_url: 'http://127.0.0.1:8080', nope: true }),
      /mkadoc:kroki-diagram:.*Unrecognized key: "nope"/,
    )
  })

  it('loadPlugins surfaces plugin option errors', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const host = createHost({
        root,
        source: 'docs',
        output: 'site',
        cache: '.cache/asciidoctor',
        docinfoDir: '.cache/asciidoctor/docinfo',
        assets: [],
        plugins: {},
      })
      await assert.rejects(
        () => loadPlugins({ 'mkadoc:nav': { bogus: true } }, host),
        /mkadoc:nav:.*Unrecognized key: "bogus"/,
      )
    })
  })
})
