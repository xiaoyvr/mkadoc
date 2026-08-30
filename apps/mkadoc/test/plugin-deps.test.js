import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { createHosts } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

/**
 * A self-contained plugin package (no runtime deps → install is pack+extract
 * only, no arborist reify). `body` is the index.js source.
 * @param {string} name
 * @param {string} body
 * @returns {Record<string, string>}
 */
function pluginFiles(name, body) {
  return {
    [`plugins/${name}/package.json`]: JSON.stringify(
      { name, version: '1.0.0', type: 'module', main: 'index.js', dependencies: {} },
      null,
      2,
    ),
    [`plugins/${name}/index.js`]: body,
  }
}

const PROVIDER = pluginFiles(
  'provider',
  `export default function providerPlugin() {
  return {
    name: 'provider',
    async setup(host) {
      host.provideService('my-cap', { ok: true })
    },
  }
}
`,
)

const CONSUMER = pluginFiles(
  'consumer',
  `export default function consumerPlugin() {
  return {
    name: 'consumer',
    requires: ['my-cap'],
  }
}
`,
)

const LOADTIME_READER = pluginFiles(
  'loadtime-reader',
  `export default function loadtimeReaderPlugin() {
  return {
    name: 'loadtime-reader',
    async setup(host) {
      host.getService('my-cap')
    },
  }
}
`,
)

const NEEDS_MISSING = pluginFiles(
  'needs-missing',
  `export default function needsMissingPlugin() {
  return {
    name: 'needs-missing',
    requires: ['no-such-service'],
  }
}
`,
)

const BAD_REQUIRES = pluginFiles(
  'bad-requires',
  `export default function badRequiresPlugin() {
  return {
    name: 'bad-requires',
    requires: 'my-cap',
  }
}
`,
)

const DISPOSABLE = pluginFiles(
  'disposable',
  `export default function disposablePlugin() {
  let disposed = false
  return {
    name: 'disposable',
    async dispose() {
      disposed = true
    },
    get wasDisposed() {
      return disposed
    },
  }
}
`,
)

function cfg(root) {
  return {
    root,
    sources: [{ path: 'docs', mount: '/docs', title: 'Docs' }],
    output: 'site',
    plugins: {},
  }
}

describe('plugin service lifecycle', () => {
  it('getService during setup throws (services only resolve after load)', async () => {
    await withTempProject(LOADTIME_READER, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/loadtime-reader': {} }, host),
        /getService\('my-cap'\) during plugin load/,
      )
    })
  })

  it('getService is resolvable after load (order-independent)', async () => {
    // consumer listed BEFORE provider — validation runs after all setups, so
    // config order cannot break a declared hard dependency
    await withTempProject({ ...PROVIDER, ...CONSUMER }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      const pluginsConfig = {
        'file:./plugins/consumer': {},
        'file:./plugins/provider': {},
      }
      const runner = await loadPlugins(pluginsConfig, host)
      assert.deepEqual(host.getService('my-cap'), { ok: true })
      assert.equal(runner.list.length, 4) // consumer + provider + 2 auto renderers
    })
  })

  it('requires a missing service → loadPlugins rejects with the locator', async () => {
    await withTempProject(NEEDS_MISSING, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/needs-missing': {} }, host),
        /needs-missing requires service "no-such-service"/,
      )
    })
  })

  it('reports every missing dependency at once', async () => {
    const second = pluginFiles(
      'also-missing',
      `export default function alsoMissingPlugin() {
        return { name: 'also-missing', requires: ['other-service'] }
      }
      `,
    )
    await withTempProject({ ...NEEDS_MISSING, ...second }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () =>
          loadPlugins(
            { 'file:./plugins/needs-missing': {}, 'file:./plugins/also-missing': {} },
            host,
          ),
        (err) => {
          assert.match(err.message, /needs-missing requires service "no-such-service"/)
          assert.match(err.message, /also-missing requires service "other-service"/)
          return true
        },
      )
    })
  })

  it('rejects a non-array requires', async () => {
    await withTempProject(BAD_REQUIRES, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/bad-requires': {} }, host),
        /bad-requires: `requires` must be an array of service names \(got string\)/,
      )
    })
  })

  it('dispose runs plugin hooks and disables further service reads', async () => {
    await withTempProject({ ...PROVIDER, ...DISPOSABLE }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      const runner = await loadPlugins(
        { 'file:./plugins/provider': {}, 'file:./plugins/disposable': {} },
        host,
      )

      const disposable = runner.list.find((e) => e.locator === 'file:./plugins/disposable')
      assert.equal(disposable.plugin.wasDisposed, false)

      await runner.dispose()
      assert.equal(disposable.plugin.wasDisposed, true)
      assert.throws(() => host.getService('my-cap'), /after plugins were disposed/)
    })
  })

  it('build disposes the previous plugin set when the plugins config changes', async () => {
    const buildDisposable = pluginFiles(
      'disposable',
      `export default function disposablePlugin() {
        return {
          name: 'disposable',
          async dispose() {
            const fs = await import('node:fs')
            fs.writeFileSync(new URL('./disposed.txt', import.meta.url), 'disposed')
          },
        }
      }
      `,
    )
    await withTempProject(
      {
        ...buildDisposable,
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  file:./plugins/disposable: {}
`),
        'docs/index.md': '# Index\n',
      },
      async (root) => {
        const cfgA = await loadConfig('mkadoc.yaml', root)
        await build(cfgA, { forceFull: true })
        assert.equal(
          fs.existsSync(path.join(root, '.mkadoc/plugins/disposable/disposed.txt')),
          false,
        )

        // drop the plugin from config → next build disposes it
        fs.writeFileSync(
          path.join(root, 'mkadoc.yaml'),
          yamlConfig(`sources:
  - docs
output: site
plugins: {}
`),
        )
        const cfgB = await loadConfig('mkadoc.yaml', root)
        await build(cfgB, { forceFull: true })

        assert.ok(fs.existsSync(path.join(root, '.mkadoc/plugins/disposable/disposed.txt')))
      },
    )
  })
})
