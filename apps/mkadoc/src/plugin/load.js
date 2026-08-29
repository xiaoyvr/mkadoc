import { pathToFileURL } from 'node:url'
import asciidoc from '../builtins/asciidoc.js'
import markdown from '../builtins/markdown.js'
import nav from '../builtins/nav.js'
import shiki from '../builtins/shiki.js'
import topbar from '../builtins/topbar.js'
import { installLocalPlugin, parseLocator, resolveEntry } from './installer.js'
import { BUILTIN_LOCATORS } from './locators.js'

/** @type {Record<string, import('./contract.js').MkadocPluginFactory>} */
const BUILTINS = {
  'mkadoc:asciidoc': asciidoc,
  'mkadoc:markdown': markdown,
  'mkadoc:nav': nav,
  'mkadoc:shiki': shiki,
  'mkadoc:topbar': topbar,
}

/** Built-in renderers are enabled unless explicitly configured. */
const AUTO_RENDERERS = ['mkadoc:asciidoc', 'mkadoc:markdown']

for (const locator of BUILTIN_LOCATORS) {
  if (!BUILTINS[locator]) {
    throw new Error(`mkadoc: missing factory for builtin locator ${locator}`)
  }
}

/**
 * Resolve a locator to a plugin factory.
 * - `mkadoc:<name>` — built-in factories shipped with mkadoc
 * - file/directory specs — installed into `.mkadoc/plugins/`, module imported
 * - anything else (registry ranges, git, remote, alias) — not implemented yet
 *
 * @param {string} locator
 * @param {import('./contract.js').MkadocPluginHost} host
 * @returns {Promise<import('./contract.js').MkadocPluginFactory>}
 */
async function resolveFactory(locator, host) {
  if (locator.startsWith('mkadoc:')) {
    const factory = BUILTINS[locator]
    if (!factory) {
      throw new Error(
        `mkadoc: unknown builtin plugin "${locator}" (known: ${BUILTIN_LOCATORS.join(', ')})`,
      )
    }
    return factory
  }

  const spec = parseLocator(locator, host.root)
  if (spec.type !== 'file' && spec.type !== 'directory') {
    throw new Error(
      `mkadoc: plugin ${JSON.stringify(locator)} (${spec.type}) is not supported yet — only local folder plugins are implemented (e.g. "file:./path/to/plugin")`,
    )
  }

  const pluginDir = await installLocalPlugin(host.root, locator)
  const entry = resolveEntry(pluginDir)
  const mod = await import(pathToFileURL(entry).href)
  const factory = mod.default ?? mod
  if (typeof factory !== 'function') {
    throw new Error(`mkadoc: plugin at ${entry} must export a factory function (default export)`)
  }
  return factory
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
  const configured = new Set(entries.map(([locator]) => locator))
  // Config order first (chrome order), then any unlisted built-in renderers.
  const ordered = [
    ...entries.map(([locator]) => locator),
    ...AUTO_RENDERERS.filter((locator) => !configured.has(locator)),
  ]

  const optionsFor = (locator) => entries.find(([k]) => k === locator)?.[1] ?? {}

  /** @type {{ locator: string, plugin: import('./contract.js').MkadocPlugin }[]} */
  const loaded = []

  // Construct all plugins in config order first (chrome order is preserved).
  for (const locator of ordered) {
    const factory = await resolveFactory(locator, host)
    const plugin = await factory(optionsFor(locator), host)
    plugin.locator = locator
    loaded.push({ locator, plugin })
  }

  // Renderers register + setup before feature plugins so feature plugins can
  // discover them (e.g. mkadoc:nav finds `_nav.<ext>` via the renderer list).
  for (const { plugin } of loaded) {
    if (plugin.kind === 'renderer') {
      host.registerRenderer(plugin)
      if (plugin.setup) await plugin.setup(host)
    }
  }
  for (const { plugin } of loaded) {
    if (plugin.kind !== 'renderer' && plugin.setup) await plugin.setup(host)
  }

  return createPluginRunner(loaded, host)
}
