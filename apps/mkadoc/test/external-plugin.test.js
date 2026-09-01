import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createHosts } from '../src/plugin/host.js'
import { installLocalPlugin } from '../src/plugin/installer.js'
import { loadPlugins } from '../src/plugin/load.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

const FIXTURE_PLUGIN = {
  'plugins/my-plugin/package.json': JSON.stringify(
    {
      name: 'my-plugin',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      dependencies: {},
    },
    null,
    2,
  ),
  'plugins/my-plugin/index.js': `export default function myPlugin(rawOptions = {}, host) {
  return host.plugin([], () => ({
    name: 'my',
    async contributeChrome(host, { mode }) {
      if (mode === 'assets') return
      host.contributeChromeBody('<aside id="mkadoc-my">my</aside>')
    },
    async check() {
      return { ok: true, message: 'my ok' }
    },
  }))
}
`,
}

function baseCfg(root, plugins) {
  return {
    root,
    sources: [{ path: 'docs', mount: '/docs', title: 'Docs' }],
    output: 'site',
    plugins,
  }
}

describe('external plugins (local folder protocol)', () => {
  it('installs, loads, and runs all hooks for a file: plugin', async () => {
    await withTempProject(FIXTURE_PLUGIN, async (root) => {
      const cfg = baseCfg(root, { 'file:./plugins/my-plugin': {} })
      const { plugin: host, build } = createHosts(cfg)
      const runner = await loadPlugins(cfg.plugins, host)

      const entry = runner.list.find((e) => e.locator === 'file:./plugins/my-plugin')
      assert.ok(entry)
      assert.equal(entry.plugin.name, 'my')
      assert.equal(entry.locator, 'file:./plugins/my-plugin')
      // contributeChrome ran
      await runner.contributeChrome({ mode: 'full', pages: [] })
      assert.deepEqual(build.chromeBody, ['<aside id="mkadoc-my">my</aside>'])
      // check ran
      const results = await runner.check()
      assert.deepEqual(results, [
        { locator: 'file:./plugins/my-plugin', ok: true, message: 'my ok' },
      ])

      // installed into .mkadoc/plugins/<name> with fingerprint marker
      const pluginDir = path.join(root, '.mkadoc/plugins/my-plugin')
      assert.ok(fs.existsSync(path.join(pluginDir, 'index.js')))
      assert.ok(fs.existsSync(path.join(pluginDir, '.mkadoc-install.json')))
    })
  })

  it('accepts the bare ./path form (npa parses both identically)', async () => {
    await withTempProject(FIXTURE_PLUGIN, async (root) => {
      const cfg = baseCfg(root, { './plugins/my-plugin': {} })
      const { plugin: host } = createHosts(cfg)
      const runner = await loadPlugins(cfg.plugins, host)
      const entry = runner.list.find((e) => e.locator === './plugins/my-plugin')
      assert.equal(entry.plugin.name, 'my')
    })
  })

  it('skips recopy + reinstall when the fingerprint matches', async () => {
    await withTempProject(FIXTURE_PLUGIN, async (root) => {
      const first = await installLocalPlugin(root, 'file:./plugins/my-plugin')
      const markerAbs = path.join(first, '.mkadoc-install.json')
      const mtime1 = fs.statSync(markerAbs).mtimeMs

      await new Promise((r) => setTimeout(r, 50))
      const second = await installLocalPlugin(root, 'file:./plugins/my-plugin')
      assert.equal(second, first)
      assert.equal(fs.statSync(markerAbs).mtimeMs, mtime1, 'marker untouched → install skipped')
    })
  })

  it('recopies and reinstalls when the source changes', async () => {
    await withTempProject(FIXTURE_PLUGIN, async (root) => {
      await installLocalPlugin(root, 'file:./plugins/my-plugin')

      // change the plugin source (new file bumps the tree hash)
      fs.writeFileSync(path.join(root, 'plugins/my-plugin/extra.txt'), 'v2\n')
      const dir = await installLocalPlugin(root, 'file:./plugins/my-plugin')

      assert.ok(fs.existsSync(path.join(dir, 'extra.txt')))
    })
  })

  it('errors for a manifest-less plugin folder (package.json required)', async () => {
    await withTempProject(
      { 'plugins/bare/index.js': 'export default () => ({ name: "bare" })' },
      async (root) => {
        await assert.rejects(
          () => installLocalPlugin(root, 'file:./plugins/bare'),
          /has no package.json/,
        )
      },
    )
  })

  it('respects package.json files selection when packing', async () => {
    await withTempProject(
      {
        ...FIXTURE_PLUGIN,
        'plugins/my-plugin/ignored.txt': 'not shipped\n',
      },
      async (root) => {
        const dir = await installLocalPlugin(root, 'file:./plugins/my-plugin')
        // files field not set → everything packs, including the txt
        assert.ok(fs.existsSync(path.join(dir, 'ignored.txt')))
      },
    )
  })

  it('errors when the plugin folder is missing', async () => {
    await withTempProject({}, async (root) => {
      await assert.rejects(
        () => installLocalPlugin(root, 'file:./plugins/nope'),
        /plugin folder not found/,
      )
    })
  })

  it('errors for unimplemented locator protocols', async () => {
    await withTempProject({}, async (root) => {
      const cfg = baseCfg(root, { 'my-registry-plugin': {} })
      const { plugin: host } = createHosts(cfg)
      await assert.rejects(() => loadPlugins(cfg.plugins, host), /not supported yet.*local folder/)
    })
  })

  it('works end to end through loadConfig with a file: plugin', async () => {
    await withTempProject(
      {
        ...FIXTURE_PLUGIN,
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
plugins:
  file:./plugins/my-plugin: {}
`),
        'docs/index.adoc': '= Index\n\nhello',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        const { plugin: host } = createHosts(cfg)
        const runner = await loadPlugins(cfg.plugins, host)
        const entry = runner.list.find((e) => e.locator === 'file:./plugins/my-plugin')
        assert.equal(entry.plugin.name, 'my')
      },
    )
  })
})
