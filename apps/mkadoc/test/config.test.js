import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig, resolveServeListen } from '../src/config.js'
import { parseProjectConfig, parseServeConfig } from '../src/config-schema.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('loadConfig (plain YAML)', () => {
  it('loads a plain YAML config', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
serve:
  remote: true
  port: 8000
`),
        'docs/index.adoc': '= Dotfiles\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(cfg.sources.length, 1)
        assert.equal(cfg.sources[0].path, 'docs')
        assert.equal(cfg.sources[0].mount, '/docs')
        assert.equal(cfg.output, 'site')
        assert.equal(cfg.site.brand, 'Docs')
        assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
        assert.equal(cfg.serve.port, 8000)
        assert.equal(cfg.serve.remote, true)
      },
    )
  })

  it('rejects non-mapping YAML', async () => {
    await withTempProject(
      { 'mkadoc.yaml': '- just\n- a\n- list\n', 'docs/.keep': '' },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yaml', root), /config must be a YAML mapping/)
      },
    )
  })

  it('rejects empty config', async () => {
    await withTempProject({ 'mkadoc.yaml': '', 'docs/.keep': '' }, async (root) => {
      await assert.rejects(() => loadConfig('mkadoc.yaml', root), /config must be a YAML mapping/)
    })
  })

  it('rejects invalid YAML', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
  bad: indent
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yaml', root), /invalid YAML in config/)
      },
    )
  })

  it('rejects a config missing the mandatory brand', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
output: site
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yaml', root), /invalid config/)
      },
    )
  })

  it('accepts .yml config extension', async () => {
    await withTempProject(
      {
        'mkadoc.yml': yamlConfig(`sources:
  - docs
output: site
`),
        'docs/index.adoc': '= Smoke\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yml', root)
        assert.equal(cfg.sources[0].path, 'docs')
        assert.equal(cfg.output, 'site')
      },
    )
  })

  it('rejects unsupported config extensions', async () => {
    await withTempProject(
      {
        'mkadoc.toml': `sources = ["docs"]\n`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(
          () => loadConfig('mkadoc.toml', root),
          /unsupported config type "\.toml"/,
        )
      },
    )
  })

  it('rejects missing config file', async () => {
    await withTempProject({}, async (root) => {
      await assert.rejects(() => loadConfig('mkadoc.yaml', root), /config not found/)
    })
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
  it('requires sources + site.brand and applies defaults', () => {
    assert.throws(() => parseProjectConfig({}), /invalid config/)
    assert.throws(() => parseProjectConfig({ sources: ['docs'] }), /invalid config/)
    assert.deepEqual(parseProjectConfig({ sources: ['docs'], site: { brand: 'Docs' } }), {
      sources: ['docs'],
      output: 'site',
      site: { brand: 'Docs' },
      plugins: {},
      serve: { remote: false, port: 8000 },
    })
  })

  it('coerces string ports from YAML-like input', () => {
    const cfg = parseProjectConfig({
      sources: ['docs'],
      site: { brand: 'Docs' },
      serve: { port: '9001', remote: true },
    })
    assert.equal(cfg.serve.port, 9001)
    assert.equal(cfg.serve.remote, true)
  })

  it('rejects unknown keys (strict schema)', () => {
    assert.throws(
      () => parseProjectConfig({ sources: ['docs'], site: { brand: 'Docs' }, fancy: true }),
      /invalid config:.*fancy/,
    )
    assert.throws(
      () =>
        parseProjectConfig({ sources: ['docs'], site: { brand: 'Docs' }, serve: { bogus: true } }),
      /invalid config:.*serve/,
    )
  })

  it('rejects unknown plugin locators', () => {
    assert.throws(
      () =>
        parseProjectConfig({
          sources: ['docs'],
          site: { brand: 'Docs' },
          plugins: { 'mkadoc:nope': {} },
        }),
      /Unknown builtin plugin/,
    )
    assert.throws(
      () =>
        parseProjectConfig({
          sources: ['docs'],
          site: { brand: 'Docs' },
          plugins: { 'not a locator!!': {} },
        }),
      /Invalid plugin locator/,
    )
  })

  it('accepts known builtin renderer/feature locators and file specs', () => {
    const cfg = parseProjectConfig({
      sources: ['docs'],
      site: { brand: 'Docs' },
      plugins: {
        'mkadoc:asciidoc': {},
        'mkadoc:markdown': { html: true },
        'mkadoc:nav': {},
        'file:./plugins/x': { server_url: 'http://127.0.0.1:8080' },
        './plugins/y': {},
      },
    })
    assert.deepEqual(cfg.plugins['mkadoc:asciidoc'], {})
    assert.equal(cfg.plugins['mkadoc:markdown'].html, true)
    assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
    assert.deepEqual(cfg.plugins['file:./plugins/x'], { server_url: 'http://127.0.0.1:8080' })
    assert.deepEqual(cfg.plugins['./plugins/y'], {})
  })

  it('loadConfig surfaces schema errors from YAML configs', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
serve:
  bogus: true
  port: 8000
`),
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yaml', root), /invalid config/)
      },
    )
  })
})
