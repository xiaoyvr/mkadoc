import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import asciidoc from '../src/builtins/asciidoc.js'
import markdown from '../src/builtins/markdown.js'
import { loadConfig, resolveServeListen } from '../src/config.js'
import { parseProjectConfig, parseServeConfig } from '../src/config-schema.js'
import { extractSourcesMeta } from '../src/sources.js'
import { withTempProject } from './helpers/project.js'

/** Renderer doubles just for metadata extraction (extractMeta needs no host). */
function metaRenderers() {
  return [asciidoc({}, null), markdown({}, null)]
}

describe('loadConfig (plain YAML)', () => {
  it('loads a plain YAML config', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
serve:
  remote: true
  port: 8000
`,
        'docs/index.adoc': '= Dotfiles\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(cfg.sources.length, 1)
        assert.equal(cfg.sources[0].path, 'docs')
        assert.equal(cfg.sources[0].mount, '/docs')
        assert.equal(cfg.output, 'site')
        assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
        assert.equal(cfg.serve.port, 8000)
        assert.equal(cfg.serve.remote, true)
      },
    )
  })

  it('derives source-bar label from :nav_label: on index.adoc via the renderer', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
`,
        'docs/index.adoc': `= Long Root Title
:nav_label: Site

Body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await extractSourcesMeta(cfg, metaRenderers())
        assert.equal(cfg.sources[0].title, 'Site')
        assert.equal(cfg.sources[0].mount, '/docs')
      },
    )
  })

  it('derives source description from :description: on index.adoc', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
`,
        'docs/index.adoc': `= Dotfiles
:description: Nix-managed system

Body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await extractSourcesMeta(cfg, metaRenderers())
        assert.equal(cfg.sources[0].description, 'Nix-managed system')
        assert.equal(cfg.sources[0].title, 'Dotfiles')
      },
    )
  })

  it('passes the absolute index path to extractMeta (base dir for includes)', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
`,
        'docs/index.md': '---\ntitle: X\n---\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        let receivedPath = null
        const spy = {
          kind: 'renderer',
          extensions: ['.md'],
          async extractMeta(_text, absPath) {
            receivedPath = absPath
            return { title: 'X', description: '' }
          },
        }
        await extractSourcesMeta(cfg, [spy])
        assert.ok(receivedPath)
        assert.ok(path.isAbsolute(receivedPath))
        assert.equal(receivedPath, path.join(root, 'docs/index.md'))
      },
    )
  })

  it('derives source-bar label from Markdown frontmatter via the renderer', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
`,
        'docs/index.md': `---
title: Markdown Docs
description: Rendered from md
---

# Hi
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await extractSourcesMeta(cfg, metaRenderers())
        assert.equal(cfg.sources[0].title, 'Markdown Docs')
        assert.equal(cfg.sources[0].description, 'Rendered from md')
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

  it('accepts .yml config extension', async () => {
    await withTempProject(
      {
        'mkadoc.yml': `sources:
  - docs
output: site
`,
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
  it('requires sources and applies defaults', () => {
    assert.throws(() => parseProjectConfig({}), /invalid config/)
    assert.deepEqual(parseProjectConfig({ sources: ['docs'] }), {
      sources: ['docs'],
      output: 'site',
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

  it('accepts known builtin renderer/feature locators and file specs', () => {
    const cfg = parseProjectConfig({
      sources: ['docs'],
      plugins: {
        'mkadoc:asciidoc': {},
        'mkadoc:markdown': { html: true },
        'mkadoc:nav': {},
        'file:./plugins/x': { server_url: 'http://127.0.0.1:8080' },
      },
    })
    assert.deepEqual(cfg.plugins['mkadoc:asciidoc'], {})
    assert.equal(cfg.plugins['mkadoc:markdown'].html, true)
    assert.deepEqual(cfg.plugins['mkadoc:nav'], {})
    assert.deepEqual(cfg.plugins['file:./plugins/x'], { server_url: 'http://127.0.0.1:8080' })
  })

  it('loadConfig surfaces schema errors from YAML configs', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': `sources:
  - docs
serve:
  bogus: true
  port: 8000
`,
        'docs/.keep': '',
      },
      async (root) => {
        await assert.rejects(() => loadConfig('mkadoc.yaml', root), /invalid config/)
      },
    )
  })
})
