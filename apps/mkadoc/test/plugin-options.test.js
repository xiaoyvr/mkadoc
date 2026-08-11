import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import navPlugin from '../src/builtins/nav.js'
import shikiPlugin from '../src/builtins/shiki.js'
import { createHost } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { resolvePluginOptions } from '../src/plugin/options.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('resolvePluginOptions', () => {
  it('merges defaults and rejects unknown keys', () => {
    assert.deepEqual(resolvePluginOptions('mkadoc:nav', {}, { nav: 'docs/_nav.adoc' }), {
      nav: 'docs/_nav.adoc',
    })
    assert.deepEqual(
      resolvePluginOptions('mkadoc:nav', { nav: 'x.adoc' }, { nav: 'docs/_nav.adoc' }),
      { nav: 'x.adoc' },
    )
    assert.throws(
      () => resolvePluginOptions('mkadoc:nav', { nope: true }, { nav: 'docs/_nav.adoc' }),
      /mkadoc:nav: unknown option: nope/,
    )
    assert.throws(
      () => resolvePluginOptions('mkadoc:nav', [], { nav: 'docs/_nav.adoc' }),
      /options must be a mapping/,
    )
  })
})

describe('plugin-owned option validation', () => {
  it('nav factory rejects unknown options', () => {
    assert.throws(() => navPlugin({ thme: 'x' }), /mkadoc:nav: unknown option/)
  })

  it('shiki factory rejects unknown options', () => {
    assert.throws(() => shikiPlugin({ thme: 'nord' }), /mkadoc:shiki: unknown option: thme/)
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
        /mkadoc:nav: unknown option: bogus/,
      )
    })
  })
})
