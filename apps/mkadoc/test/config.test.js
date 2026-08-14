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
sources:
  - docs
serve:
  port: 8000
----

More prose.

[mkadoc-config]
----
plugins:
  mkadoc:nav: {}
serve:
  remote: true
----
`,
        'docs/index.adoc': '= Dotfiles\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(cfg.sources.length, 1)
        assert.equal(cfg.sources[0].path, 'docs')
        assert.equal(cfg.sources[0].mount, '/')
        assert.equal(cfg.sources[0].title, 'Dotfiles')
        assert.equal(cfg.serve.port, 8000)
        assert.equal(cfg.serve.remote, true)
        assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
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
sources:
  - docs
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
sources:
  - docs
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
sources:
  - docs
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
        'mkadoc.yml': `sources:
  - docs
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
        'mkadoc.asciidoc': literateConfig(`sources:
  - docs
output: site
`),
        'docs/index.adoc': '= Smoke\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.asciidoc', root)
        assert.equal(cfg.sources[0].path, 'docs')
        assert.equal(cfg.output, 'site')
      },
    )
  })

  it('derives tab title from :tab: on index.adoc', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
`),
        'docs/index.adoc': `= Long Root Title
:tab: Site

Body.
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc tool

Body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(cfg.sources[0].title, 'Site')
        assert.equal(cfg.sources[0].mount, '/')
        assert.equal(cfg.sources[1].title, 'mkadoc tool')
        assert.equal(cfg.sources[1].mount, '/apps/mkadoc')
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
  it('requires sources and applies defaults', () => {
    assert.throws(() => parseProjectConfig({}), /invalid config/)
    assert.deepEqual(parseProjectConfig({ sources: ['docs'] }), {
      sources: ['docs'],
      output: 'site',
      assets: [],
      plugins: {},
      serve: { remote: false, port: 8000 },
    })
  })

  it('coerces string ports from YAML-like input', () => {
    const cfg = parseProjectConfig({ sources: ['docs'], serve: { port: '9001', remote: true } })
    assert.equal(cfg.serve.port, 9001)
    assert.equal(cfg.serve.remote, true)
  })

  it('rejects unknown keys (strict schema)', () => {
    assert.throws(
      () => parseProjectConfig({ sources: ['docs'], fancy: true }),
      /invalid config:.*fancy/,
    )
    assert.throws(
      () => parseProjectConfig({ sources: ['docs'], serve: { bogus: true } }),
      /invalid config:.*serve/,
    )
  })

  it('rejects unknown plugin locators', () => {
    assert.throws(
      () => parseProjectConfig({ sources: ['docs'], plugins: { 'mkadoc:nope': {} } }),
      /invalid config:.*plugins/,
    )
  })

  it('accepts known plugin option objects without validating fields', () => {
    const cfg = parseProjectConfig({
      sources: ['docs'],
      plugins: {
        'mkadoc:nav': {},
        'mkadoc:shiki': { theme: 'nord', thme: 'typo' },
        'mkadoc:kroki-diagram': { server_url: 'http://127.0.0.1:8080' },
      },
    })
    assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
    assert.equal(cfg.plugins['mkadoc:shiki'].theme, 'nord')
    assert.equal(cfg.plugins['mkadoc:shiki'].thme, 'typo')
  })

  it('loadConfig surfaces schema errors from literate configs', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
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
