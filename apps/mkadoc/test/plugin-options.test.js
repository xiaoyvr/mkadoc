import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import krokiDiagramPlugin from '../src/builtins/kroki-diagram.js'
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

  it('nav factory rejects legacy css_href / js_href options', () => {
    assert.throws(() => navPlugin({ css_href: '/x.css' }), /mkadoc:nav:.*Unrecognized key/)
    assert.throws(() => navPlugin({ js_href: '/x.js' }), /mkadoc:nav:.*Unrecognized key/)
  })

  it('nav factory rejects legacy nav path option', () => {
    assert.throws(() => navPlugin({ nav: 'docs/_nav.adoc' }), /mkadoc:nav:.*Unrecognized key/)
  })

  it('loadPlugins surfaces plugin option errors', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { plugin } = createHosts({
        root,
        sources: [{ path: 'docs', mount: '/', title: 'Docs' }],
        output: 'site',
        docinfoDir: '.cache/docinfo',
        assets: [],
        plugins: {},
      })
      await assert.rejects(
        () => loadPlugins({ 'mkadoc:nav': { bogus: true } }, plugin),
        /mkadoc:nav:.*Unrecognized key: "bogus"/,
      )
    })
  })
})
