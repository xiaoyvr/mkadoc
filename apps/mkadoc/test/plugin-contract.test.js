import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHost } from '../src/plugin/host.js'
import { loadPluginInstances } from '../src/plugin/load.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

describe('plugin contract lifecycle', () => {
  it('invokes setup, then contributeChrome, then check in order', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      /** @type {string[]} */
      const events = []
      const host = createHost({
        root,
        source: 'docs',
        output: 'site',
        cache: '.cache/asciidoctor',
        docinfoDir: '.cache/asciidoctor/docinfo',
        assets: [],
        plugins: {},
      })

      const plugins = await loadPluginInstances(
        [
          {
            name: 'alpha',
            async setup() {
              events.push('setup:alpha')
            },
            async contributeChrome(_host, ctx) {
              events.push(`chrome:alpha:${ctx.mode}`)
            },
            async check() {
              events.push('check:alpha')
              return { ok: true, message: 'alpha ok' }
            },
          },
          {
            name: 'beta',
            async setup() {
              events.push('setup:beta')
            },
            async contributeChrome() {
              events.push('chrome:beta')
            },
            async check() {
              events.push('check:beta')
              return { ok: true }
            },
          },
        ],
        host,
      )

      assert.deepEqual(events, ['setup:alpha', 'setup:beta'])

      await plugins.contributeChrome({ mode: 'full', pages: [] })
      assert.deepEqual(events, ['setup:alpha', 'setup:beta', 'chrome:alpha:full', 'chrome:beta'])

      const results = await plugins.check()
      assert.deepEqual(events, [
        'setup:alpha',
        'setup:beta',
        'chrome:alpha:full',
        'chrome:beta',
        'check:alpha',
        'check:beta',
      ])
      assert.deepEqual(results, [
        { locator: 'alpha', ok: true, message: 'alpha ok' },
        { locator: 'beta', ok: true },
      ])
    })
  })
})
