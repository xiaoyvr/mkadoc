import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadConfig,
  loadLiterateConfig,
  parsePort,
  parseProjectConfig,
  resolveServeListen,
} from '../src/config.js'
import { withTempProject } from './helpers/project.js'

describe('loadLiterateConfig', () => {
  it('merges multiple [mkadoc-config] YAML blocks', async () => {
    const source = `= Site

[mkadoc-config]
----
source: docs
serve:
  port: 8000
----

More prose.

[mkadoc-config]
----
plugins:
  mkadoc:nav:
    nav: docs/_nav.adoc
serve:
  remote: true
----
`
    assert.deepEqual(await loadLiterateConfig(source), {
      source: 'docs',
      serve: { port: 8000, remote: true },
      plugins: { 'mkadoc:nav': { nav: 'docs/_nav.adoc' } },
    })
  })

  it('skips empty config blocks', async () => {
    const source = `= Site

[mkadoc-config]
----
----

[mkadoc-config]
----
output: site
----
`
    assert.deepEqual(await loadLiterateConfig(source), { output: 'site' })
  })

  it('rejects non-mapping YAML in a config block', async () => {
    const source = `= Site

[mkadoc-config]
----
- just
- a
- list
----
`
    await assert.rejects(() => loadLiterateConfig(source), /must be a YAML mapping/)
  })

  it('returns {} when there are no config blocks', async () => {
    assert.deepEqual(await loadLiterateConfig('= Just a doc\n\nHello.\n'), {})
  })
})

describe('parsePort', () => {
  it('accepts valid ports and rejects invalid ones', () => {
    assert.equal(parsePort('8765'), 8765)
    assert.equal(parsePort(1), 1)
    assert.equal(parsePort(65535), 65535)
    assert.throws(() => parsePort('nope', '--port'), /invalid --port: nope/)
    assert.throws(() => parsePort(0), /invalid serve.port: 0/)
    assert.throws(() => parsePort(65536), /invalid serve.port/)
  })
})

describe('resolveServeListen', () => {
  it('defaults to localhost:8000', () => {
    assert.deepEqual(resolveServeListen(), {
      host: '127.0.0.1',
      port: 8000,
      remote: false,
    })
  })

  it('remote true binds 0.0.0.0', () => {
    assert.deepEqual(resolveServeListen({ remote: true, port: 9000 }), {
      host: '0.0.0.0',
      port: 9000,
      remote: true,
    })
  })
})

describe('parseProjectConfig (zod schema)', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseProjectConfig({}), {
      source: 'docs',
      output: 'site',
      cache: '.cache/asciidoctor',
      assets: [],
      plugins: {},
      serve: { remote: false, port: 8000 },
    })
  })

  it('coerces string ports from YAML-like input', () => {
    const cfg = parseProjectConfig({ serve: { port: '9001', remote: true } })
    assert.equal(cfg.serve.port, 9001)
    assert.equal(cfg.serve.remote, true)
  })

  it('rejects unknown keys (strict schema)', () => {
    assert.throws(
      () => parseProjectConfig({ source: 'docs', fancy: true }),
      /invalid config:.*fancy/,
    )
    assert.throws(() => parseProjectConfig({ serve: { bogus: true } }), /invalid config:.*serve/)
  })

  it('rejects unknown plugin locators', () => {
    assert.throws(
      () => parseProjectConfig({ plugins: { 'mkadoc:nope': {} } }),
      /invalid config:.*plugins/,
    )
  })

  it('accepts known plugin option objects', () => {
    const cfg = parseProjectConfig({
      plugins: {
        'mkadoc:nav': { nav: 'docs/_nav.adoc' },
        'mkadoc:shiki': { theme: 'nord' },
        'mkadoc:kroki-diagram': { server_url: 'http://127.0.0.1:8080' },
      },
    })
    assert.equal(cfg.plugins['mkadoc:nav'].nav, 'docs/_nav.adoc')
    assert.equal(cfg.plugins['mkadoc:shiki'].theme, 'nord')
  })

  it('loadConfig surfaces schema errors from YAML files', async () => {
    await withTempProject(
      {
        'mkadoc.yml': `source: docs
serve:
  bogus: true
  port: 8000
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yml', root), /invalid config/)
      },
    )
  })
})
