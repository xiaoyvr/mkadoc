import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig, resolveServeListen } from '../src/config.js'
import { parseProjectConfig, parseServeConfig } from '../src/config-schema.js'
import { literateConfig, withTempProject } from './helpers/project.js'

describe('loadConfig (literate AsciiDoc)', () => {
  it('merges multiple [mkadoc-config] YAML blocks', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

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
`,
        'docs/.keep': '',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(cfg.source, 'docs')
        assert.equal(cfg.serve.port, 8000)
        assert.equal(cfg.serve.remote, true)
        assert.equal(cfg.plugins['mkadoc:nav'].nav, 'docs/_nav.adoc')
      },
    )
  })

  it('skips empty config blocks', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

[mkadoc-config]
----
----

[mkadoc-config]
----
output: site
----
`,
        'docs/.keep': '',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(cfg.output, 'site')
      },
    )
  })

  it('rejects non-mapping YAML in a config block', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

[mkadoc-config]
----
- just
- a
- list
----
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.adoc', root), /must be a YAML mapping/)
      },
    )
  })

  it('replaces arrays from later config blocks instead of concatenating', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

[mkadoc-config]
----
assets:
  - from: a
    to: b
----

[mkadoc-config]
----
assets:
  - from: c
    to: d
----
`,
        'docs/.keep': '',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.deepEqual(cfg.assets, [{ from: 'c', to: 'd' }])
      },
    )
  })

  it('rejects configs without a [mkadoc-config] block', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

Narrative only.
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(
          () => loadConfig('mkadoc.adoc', root),
          /at least one \[mkadoc-config\] block/,
        )
      },
    )
  })

  it('rejects invalid YAML inside a [mkadoc-config] block', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': `= Site

[mkadoc-config]
----
source: docs
  bad: indent
----
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(
          () => loadConfig('mkadoc.adoc', root),
          /invalid YAML in \[mkadoc-config\] block/,
        )
      },
    )
  })

  it('rejects .yml / .yaml config paths', async () => {
    await withTempProject(
      {
        'mkadoc.yml': `source: docs
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(
          () => loadConfig('mkadoc.yml', root),
          /unsupported config type "\.yml"/,
        )
      },
    )
  })

  it('accepts .asciidoc config extension', async () => {
    await withTempProject(
      {
        'mkadoc.asciidoc': literateConfig(`source: docs
output: site
`),
        'docs/.keep': '',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.asciidoc', root)
        assert.equal(cfg.source, 'docs')
        assert.equal(cfg.output, 'site')
      },
    )
  })
})

describe('parseServeConfig', () => {
  it('accepts valid ports and rejects invalid ones', () => {
    assert.equal(parseServeConfig({ port: '8765' }).port, 8765)
    assert.equal(parseServeConfig({ port: 1 }).port, 1)
    assert.equal(parseServeConfig({ port: 65535 }).port, 65535)
    assert.throws(() => parseServeConfig({ port: 'nope' }), /invalid serve/)
    assert.throws(() => parseServeConfig({ port: 0 }), /invalid serve/)
    assert.throws(() => parseServeConfig({ port: 65536 }), /invalid serve/)
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

  it('accepts known plugin option objects without validating fields', () => {
    const cfg = parseProjectConfig({
      plugins: {
        'mkadoc:nav': { nav: 'docs/_nav.adoc' },
        'mkadoc:shiki': { theme: 'nord', thme: 'typo' },
        'mkadoc:kroki-diagram': { server_url: 'http://127.0.0.1:8080' },
      },
    })
    assert.equal(cfg.plugins['mkadoc:nav'].nav, 'docs/_nav.adoc')
    assert.equal(cfg.plugins['mkadoc:shiki'].theme, 'nord')
    assert.equal(cfg.plugins['mkadoc:shiki'].thme, 'typo')
  })

  it('loadConfig surfaces schema errors from literate configs', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`source: docs
serve:
  bogus: true
  port: 8000
`),
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.adoc', root), /invalid config/)
      },
    )
  })
})
