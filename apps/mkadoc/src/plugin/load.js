import krokiDiagram from '../plugins/kroki-diagram.js'
import nav from '../plugins/nav.js'
import shiki, { afterPluginsLoaded } from '../plugins/shiki.js'
import './contract.js'

/** @type {Record<string, import('./contract.js').MkadocPluginFactory>} */
const BUILTINS = {
  'mkadoc:kroki-diagram': krokiDiagram,
  'mkadoc:nav': nav,
  'mkadoc:shiki': shiki,
}

/**
 * @param {{ locator: string, plugin: import('./contract.js').MkadocPlugin }[]} loaded
 * @param {import('./contract.js').MkadocHost} host
 */
function createPluginRunner(loaded, host) {
  return {
    list: loaded,
    /**
     * @param {import('./contract.js').BuildContext} ctx
     */
    async contributeChrome(ctx) {
      for (const { plugin } of loaded) {
        if (plugin.contributeChrome) await plugin.contributeChrome(host, ctx)
      }
    },
    async check() {
      /** @type {{ locator: string, ok: boolean, message?: string }[]} */
      const results = []
      for (const { locator, plugin } of loaded) {
        if (!plugin.check) continue
        const result = await plugin.check(host)
        results.push({ locator, ...(result || { ok: true }) })
      }
      return results
    },
  }
}

/**
 * @param {Record<string, object> | null | undefined} pluginsConfig
 * @param {import('./contract.js').MkadocHost} host
 */
export async function loadPlugins(pluginsConfig, host) {
  const entries = Object.entries(pluginsConfig || {})
  /** @type {{ locator: string, plugin: import('./contract.js').MkadocPlugin }[]} */
  const loaded = []

  for (const [locator, options] of entries) {
    const factory = BUILTINS[locator]
    if (!factory) {
      throw new Error(
        `mkadoc: unknown plugin "${locator}" (only built-in mkadoc:* plugins are supported)`,
      )
    }
    const plugin = factory(options || {})
    plugin.locator = locator
    if (plugin.setup) await plugin.setup(host)
    loaded.push({ locator, plugin })
  }

  // Drop process-global Shiki runtime when the plugin is no longer enabled
  // (e.g. config reload under `mkadoc serve`).
  afterPluginsLoaded(loaded.map(({ locator }) => locator))

  return createPluginRunner(loaded, host)
}

/**
 * Test helper: load an ordered list of plugin instances (bypass builtin registry).
 * @param {import('./contract.js').MkadocPlugin[]} plugins
 * @param {import('./contract.js').MkadocHost} host
 */
export async function loadPluginInstances(plugins, host) {
  /** @type {{ locator: string, plugin: import('./contract.js').MkadocPlugin }[]} */
  const loaded = []
  for (const plugin of plugins) {
    const locator = plugin.locator || plugin.name
    plugin.locator = locator
    if (plugin.setup) await plugin.setup(host)
    loaded.push({ locator, plugin })
  }
  return createPluginRunner(loaded, host)
}
