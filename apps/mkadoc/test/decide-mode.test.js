import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { decideMode } from '../src/build.js'
import { createHost } from '../src/plugin/host.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

/**
 * @param {string} root
 * @param {{ assetPrefixes?: string[], classifyFull?: string[] }} [opts]
 */
function makeCtx(root, opts = {}) {
  const cfg = {
    root,
    source: 'docs',
    output: 'site',
    cache: '.cache/asciidoctor',
    configPath: path.join(root, 'mkadoc.yml'),
    docinfoDir: path.join('.cache/asciidoctor', 'docinfo'),
    assets: [],
    plugins: {},
  }
  const host = createHost(cfg)
  for (const prefix of opts.assetPrefixes || []) {
    host.registerAssetPrefix(prefix)
  }
  if (opts.classifyFull?.length) {
    const set = new Set(opts.classifyFull)
    host.registerClassifier((p) => (set.has(p) ? 'full' : null))
  }
  return { cfg, host }
}

describe('decideMode (edges not covered by smoke)', () => {
  it('normalizes absolute page paths to incremental', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(
        decideMode(cfg, host, {
          paths: [path.join(root, 'docs/guide.adoc')],
        }),
        { mode: 'incremental', pages: ['docs/guide.adoc'] },
      )
    })
  })

  it('multiple pages → incremental with all of them', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(
        decideMode(cfg, host, {
          paths: ['docs/index.adoc', 'docs/guide.adoc'],
        }),
        {
          mode: 'incremental',
          pages: ['docs/index.adoc', 'docs/guide.adoc'],
        },
      )
    })
  })

  it('host classifier full → full', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root, {
        classifyFull: ['docs/guide.adoc'],
      })
      assert.deepEqual(decideMode(cfg, host, { paths: ['docs/guide.adoc'] }), {
        mode: 'full',
        pages: [],
      })
    })
  })

  it('host assetPrefixes → assets', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root, {
        assetPrefixes: ['site/styles'],
      })
      assert.deepEqual(decideMode(cfg, host, { paths: ['site/styles/shiki.css'] }), {
        mode: 'assets',
        pages: [],
      })
    })
  })

  it('unknown non-page path → full', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(decideMode(cfg, host, { paths: ['docs/missing.adoc'] }), {
        mode: 'full',
        pages: [],
      })
      assert.deepEqual(decideMode(cfg, host, { paths: ['README.md'] }), {
        mode: 'full',
        pages: [],
      })
    })
  })

  it('page + styles → incremental (pages win over assets-only)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(
        decideMode(cfg, host, {
          paths: ['docs/styles/site.css', 'docs/guide.adoc'],
        }),
        { mode: 'incremental', pages: ['docs/guide.adoc'] },
      )
    })
  })

  it('partial among pages → full', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(
        decideMode(cfg, host, {
          paths: ['docs/guide.adoc', 'docs/_partial.adoc'],
        }),
        { mode: 'full', pages: [] },
      )
    })
  })

  it('config path via decideMode → full', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const { cfg, host } = makeCtx(root)
      assert.deepEqual(decideMode(cfg, host, { paths: ['mkadoc.yml'] }), {
        mode: 'full',
        pages: [],
      })
    })
  })
})
