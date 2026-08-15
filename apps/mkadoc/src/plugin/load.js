import krokiDiagram from '../builtins/kroki-diagram.js'
import nav from '../builtins/nav.js'
import shiki, { afterPluginsLoaded } from '../builtins/shiki.js'
import { BUILTIN_LOCATORS } from './locators.js'

/** @type {Record<string, import('./contract.js').MkadocPluginFactory>} */
const BUILTINS = {
  'mkadoc:kroki-diagram': krokiDiagram,
  'mkadoc:nav': nav,
  'mkadoc:shiki': shiki,
}

for (const locator of BUILTIN_LOCATORS) {
  if (!BUILTINS[locator]) {
    throw new Error(`mkadoc: missing factory for builtin locator ${locator}`)
  }
}

/**
 * @param {{ locator: string, plugin: import('./contract.js').MkadocPlugin }[]} loaded
 * @param {import('./contract.js').MkadocPluginHost} host
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
 * @param {Record<string, Record<string, unknown>> | null | undefined} pluginsConfig
 * @param {import('./contract.js').MkadocPluginHost} host
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

  afterPluginsLoaded(loaded.map(({ locator }) => locator))

  return createPluginRunner(loaded, host)
}
