import krokiDiagram from '../plugins/kroki-diagram.js'
import nav from '../plugins/nav.js'
import shiki from '../plugins/shiki.js'

const BUILTINS = {
  'mkadoc:kroki-diagram': krokiDiagram,
  'mkadoc:nav': nav,
  'mkadoc:shiki': shiki,
}

/**
 * @param {Record<string, object> | null | undefined} pluginsConfig
 * @param {ReturnType<import('./host.js').createHost>} host
 */
export async function loadPlugins(pluginsConfig, host) {
  const entries = Object.entries(pluginsConfig || {})
  /** @type {{ locator: string, plugin: object }[]} */
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
    if (plugin.contributeConvert) await plugin.contributeConvert(host)
    loaded.push({ locator, plugin })
  }

  return {
    list: loaded,
    async beforeBuild(ctx) {
      for (const { plugin } of loaded) {
        if (plugin.beforeBuild) await plugin.beforeBuild(host, ctx)
      }
    },
    async afterChrome(ctx) {
      for (const { plugin } of loaded) {
        if (plugin.afterChrome) await plugin.afterChrome(host, ctx)
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
