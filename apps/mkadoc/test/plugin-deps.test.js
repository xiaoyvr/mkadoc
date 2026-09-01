import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { createHosts } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { createSession } from '../src/session.js'
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

// --- DI fixtures: capabilities declared via host.provide, deps via host.plugin

const DI_PROVIDER = pluginFiles(
  'di-provider',
  `export default function diProviderPlugin(rawOptions = {}, host) {
  host.provide('my-cap', () => ({ ok: true }))
  return host.plugin([], () => ({ name: 'di-provider' }))
}
`,
)

const DI_CONSUMER = pluginFiles(
  'di-consumer',
  `export default function diConsumerPlugin(rawOptions = {}, host) {
  return host.plugin(['my-cap'], (myCap) => ({
    name: 'di-consumer',
    get cap() {
      return myCap
    },
  }))
}
`,
)

const DI_OPTIONAL = pluginFiles(
  'di-optional',
  `export default function diOptionalPlugin(rawOptions = {}, host) {
  return host.plugin(['no-such-cap?'], (missing) => ({
    name: 'di-optional',
    get missing() {
      return missing
    },
  }))
}
`,
)

const DI_NEEDS_MISSING = pluginFiles(
  'di-needs-missing',
  `export default function diNeedsMissingPlugin(rawOptions = {}, host) {
  return host.plugin(['no-such-cap'], () => ({ name: 'di-needs-missing' }))
}
`,
)

const DI_DUP_A = pluginFiles(
  'di-dup-a',
  `export default function diDupAPlugin(rawOptions = {}, host) {
  host.provide('dup', () => 1)
  return host.plugin([], () => ({ name: 'di-dup-a' }))
}
`,
)

const DI_DUP_B = pluginFiles(
  'di-dup-b',
  `export default function diDupBPlugin(rawOptions = {}, host) {
  host.provide('dup', () => 2)
  return host.plugin([], () => ({ name: 'di-dup-b' }))
}
`,
)

const DI_BAD_PROVIDE = pluginFiles(
  'di-bad-provide',
  `export default function diBadProvidePlugin(rawOptions = {}, host) {
  return host.plugin([], () => ({
    name: 'di-bad-provide',
    async setup(host) {
      host.provide('late', () => 1)
    },
  }))
}
`,
)

const DI_BAD_IMPORT = pluginFiles(
  'di-bad-import',
  `export default async function diBadImportPlugin(rawOptions = {}, host) {
  await host.import('no-such-module')
}
`,
)

const DI_BAD_DEPS = pluginFiles(
  'di-bad-deps',
  `export default function diBadDepsPlugin(rawOptions = {}, host) {
  return host.plugin('not-an-array', () => ({ name: 'di-bad-deps' }))
}
`,
)

const DI_GARBAGE = pluginFiles(
  'di-garbage',
  `export default function diGarbagePlugin() {
  return null
}
`,
)

const SESSION_COUNTED = pluginFiles(
  'session-counted',
  `import fs from 'node:fs'

export default function sessionCountedPlugin(rawOptions = {}, host) {
  const key = rawOptions.key ?? 'default'
  host.provide(
    'counted-cap',
    async () => {
      fs.appendFileSync(new URL('./runs.txt', import.meta.url), key + '\\n')
      return { key }
    },
    {
      key,
      onRelease() {
        fs.appendFileSync(new URL('./released.txt', import.meta.url), key + '\\n')
      },
    },
  )
  return host.plugin(['counted-cap'], (cap) => ({ name: 'session-counted', cap }))
}
`,
)

const DISPOSABLE = pluginFiles(
  'disposable',
  `export default function disposablePlugin(rawOptions = {}, host) {
  let disposed = false
  return host.plugin([], () => ({
    name: 'disposable',
    async dispose() {
      disposed = true
    },
    get wasDisposed() {
      return disposed
    },
  }))
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

describe('plugin DI lifecycle', () => {
  it('resolves declared dependencies after all factories run (order-independent)', async () => {
    // consumer listed BEFORE provider — declarations resolve after every
    // factory, so config order cannot break a declared dependency
    await withTempProject({ ...DI_PROVIDER, ...DI_CONSUMER }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      const runner = await loadPlugins(
        { 'file:./plugins/di-consumer': {}, 'file:./plugins/di-provider': {} },
        host,
      )
      const consumer = runner.list.find((e) => e.locator === 'file:./plugins/di-consumer')
      assert.deepEqual(consumer.plugin.cap, { ok: true })
      assert.equal(runner.list.length, 4) // consumer + provider + 2 auto renderers
    })
  })

  it('injects optional deps as undefined when nothing provides them', async () => {
    await withTempProject(DI_OPTIONAL, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      const runner = await loadPlugins({ 'file:./plugins/di-optional': {} }, host)
      const plugin = runner.list.find((e) => e.locator === 'file:./plugins/di-optional')
      assert.equal(plugin.plugin.missing, undefined)
    })
  })

  it('missing required dependency → loadPlugins rejects with owner + name', async () => {
    await withTempProject(DI_NEEDS_MISSING, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-needs-missing': {} }, host),
        /di-needs-missing depends on "no-such-cap"/,
      )
    })
  })

  it('reports every missing dependency at once', async () => {
    const second = pluginFiles(
      'also-missing',
      `export default function alsoMissingPlugin(rawOptions = {}, host) {
        return host.plugin(['other-cap'], () => ({ name: 'also-missing' }))
      }
      `,
    )
    await withTempProject({ ...DI_NEEDS_MISSING, ...second }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () =>
          loadPlugins(
            { 'file:./plugins/di-needs-missing': {}, 'file:./plugins/also-missing': {} },
            host,
          ),
        (err) => {
          assert.match(err.message, /di-needs-missing depends on "no-such-cap"/)
          assert.match(err.message, /also-missing depends on "other-cap"/)
          return true
        },
      )
    })
  })

  it('rejects a second provider for the same capability, naming both owners', async () => {
    await withTempProject({ ...DI_DUP_A, ...DI_DUP_B }, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-dup-a': {}, 'file:./plugins/di-dup-b': {} }, host),
        /di-dup-b tries to provide "dup" but it is already provided by .*di-dup-a/,
      )
    })
  })

  it('provide() outside the factory phase throws', async () => {
    await withTempProject(DI_BAD_PROVIDE, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-bad-provide': {} }, host),
        /provide\(\) is only callable from the plugin factory/,
      )
    })
  })

  it('host.import rejects names outside the core module whitelist', async () => {
    await withTempProject(DI_BAD_IMPORT, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-bad-import': {} }, host),
        /host.import\('no-such-module'\) failed.*not on mkadoc's core module whitelist/,
      )
    })
  })

  it('rejects a non-array dependency list', async () => {
    await withTempProject(DI_BAD_DEPS, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-bad-deps': {} }, host),
        /dependencies must be an array of names \(got string\)/,
      )
    })
  })

  it('rejects a factory that returns neither a plugin nor a declaration', async () => {
    await withTempProject(DI_GARBAGE, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/di-garbage': {} }, host),
        /must return a host\.plugin\(deps, create\) declaration/,
      )
    })
  })
})

describe('session-scoped dependency registry', () => {
  it('retains a provider value across rebuilds; releases on key change and removal', async () => {
    await withTempProject(
      {
        ...SESSION_COUNTED,
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  file:./plugins/session-counted:
    key: a
`),
        'docs/index.md': '# Index\n',
      },
      async (root) => {
        const session = createSession()
        const pluginDir = path.join(root, '.mkadoc/plugins/session-counted')
        const runs = () =>
          fs
            .readFileSync(path.join(pluginDir, 'runs.txt'), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
        const released = () =>
          fs.existsSync(path.join(pluginDir, 'released.txt'))
            ? fs
                .readFileSync(path.join(pluginDir, 'released.txt'), 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
            : []

        const cfgA = await loadConfig('mkadoc.yaml', root)
        await build(cfgA, { forceFull: true, session })
        assert.deepEqual(runs(), ['a'], 'provider runs on first build')

        // Same config, same session → value memoized, provider does NOT re-run
        // (this is the serve-rebuild path: expensive construction once/session).
        await build(cfgA, { forceFull: true, session })
        assert.deepEqual(runs(), ['a'], 'provider retained across rebuilds')
        assert.deepEqual(released(), [])

        // Option change → new key → old value released, provider re-runs.
        fs.writeFileSync(
          path.join(root, 'mkadoc.yaml'),
          yamlConfig(
            `sources:\n  - docs\noutput: site\nplugins:\n  file:./plugins/session-counted:\n    key: b\n`,
          ),
        )
        const cfgB = await loadConfig('mkadoc.yaml', root)
        await build(cfgB, { forceFull: true, session })
        assert.deepEqual(runs(), ['a', 'b'])
        assert.deepEqual(released(), ['a'], 'old key released on replace')

        // Removal from config → entry pruned at end of load, released.
        fs.writeFileSync(
          path.join(root, 'mkadoc.yaml'),
          yamlConfig(`sources:\n  - docs\noutput: site\nplugins: {}\n`),
        )
        const cfgC = await loadConfig('mkadoc.yaml', root)
        await build(cfgC, { forceFull: true, session })
        assert.deepEqual(released(), ['a', 'b'], 'removed provider released')
      },
    )
  })
})

describe('core-provided capabilities', () => {
  it('site-root is injectable and sets the session build slot when called', async () => {
    const SR_SETTER = pluginFiles(
      'sr-setter',
      `export default function srSetterPlugin(rawOptions = {}, host) {
        return host.plugin(['site-root'], (setSiteRoot) => ({
          name: 'sr-setter',
          async setup() {
            setSiteRoot('/docs/index.html')
          },
        }))
      }
      `,
    )
    await withTempProject(SR_SETTER, async (root) => {
      const session = createSession()
      const { plugin: host } = createHosts(cfg(root), { session })
      const runner = await loadPlugins({ 'file:./plugins/sr-setter': {} }, host)
      assert.equal(session.build.siteRoot, '/docs/index.html')
      assert.equal(
        runner.list.find((e) => e.locator === 'file:./plugins/sr-setter').plugin.name,
        'sr-setter',
      )
    })
  })

  it('site-root cannot be shadowed by a plugin provide', async () => {
    const SHADOW = pluginFiles(
      'shadow-site-root',
      `export default function shadowSiteRootPlugin(rawOptions = {}, host) {
        host.provide('site-root', () => () => {})
        return host.plugin([], () => ({ name: 'shadow-site-root' }))
      }
      `,
    )
    await withTempProject(SHADOW, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      await assert.rejects(
        () => loadPlugins({ 'file:./plugins/shadow-site-root': {} }, host),
        /tries to provide "site-root" but it is reserved by mkadoc core/,
      )
    })
  })
})

describe('plugin dispose lifecycle', () => {
  it('dispose runs plugin hooks in reverse load order', async () => {
    await withTempProject(DISPOSABLE, async (root) => {
      const { plugin: host } = createHosts(cfg(root))
      const runner = await loadPlugins({ 'file:./plugins/disposable': {} }, host)

      const disposable = runner.list.find((e) => e.locator === 'file:./plugins/disposable')
      assert.equal(disposable.plugin.wasDisposed, false)

      await runner.dispose()
      assert.equal(disposable.plugin.wasDisposed, true)
    })
  })

  it('build disposes the previous plugin set when the plugins config changes', async () => {
    const buildDisposable = pluginFiles(
      'disposable',
      `export default function disposablePlugin(rawOptions = {}, host) {
        return host.plugin([], () => ({
          name: 'disposable',
          async dispose() {
            const fs = await import('node:fs')
            fs.writeFileSync(new URL('./disposed.txt', import.meta.url), 'disposed')
          },
        }))
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
        // Same session across both builds: plugin disposal bookkeeping is
        // session state, exactly as under serve.
        const session = createSession()
        const cfgA = await loadConfig('mkadoc.yaml', root)
        await build(cfgA, { forceFull: true, session })
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
        await build(cfgB, { forceFull: true, session })

        assert.ok(fs.existsSync(path.join(root, '.mkadoc/plugins/disposable/disposed.txt')))
      },
    )
  })
})
