import { pathToFileURL } from 'node:url'
import asciidoc from '../builtins/asciidoc.js'
import markdown from '../builtins/markdown.js'
import nav from '../builtins/nav.js'
import shiki from '../builtins/shiki.js'
import topbar from '../builtins/topbar.js'
import { DECLARATION } from './host.js'
import { installLocalPlugin, parseLocator, resolveEntry } from './installer.js'
import { BUILTIN_LOCATORS } from './locators.js'

/** @type {Record<string, import('@mkadoc/plugin-host').MkadocPluginFactory>} */
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
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @returns {Promise<import('@mkadoc/plugin-host').MkadocPluginFactory>}
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
 * Run one factory and append its `host.plugin(...)` declaration to `loaded`
 * in config order. Factories must return a declaration — plugin objects are
 * created later, in config order, after every dependency resolves.
 *
 * @typedef {{ owner: string, deps: { name: string, optional: boolean }[], create: (deps: unknown[]) => import('@mkadoc/plugin-host').MkadocPlugin | Promise<import('@mkadoc/plugin-host').MkadocPlugin> }} PluginDeclaration
 *
 * @param {string} locator
 * @param {import('@mkadoc/plugin-host').MkadocPluginFactory} factory
 * @param {Record<string, unknown>} options
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {{ loaded: { locator: string, plugin: import('@mkadoc/plugin-host').MkadocPlugin }[], declarations: PluginDeclaration[] }} acc
 */
async function constructPlugin(locator, factory, options, host, acc) {
  host.setOwner(locator)
  const result = await factory(options, host)
  const declaration = result?.[DECLARATION]
  if (!declaration) {
    throw new Error(
      `mkadoc: plugin "${locator}" must return a host.plugin(deps, create) declaration (got ${typeof result})`,
    )
  }
  acc.declarations.push(declaration)
}

/**
 * Resolve every declaration's dependencies (coverage check first, then run
 * the needed provider factories — memoized in the registry — then call each
 * `create` in config order), appending the resulting plugin objects to
 * `loaded`.
 *
 * @param {{ loaded: { locator: string, plugin: import('@mkadoc/plugin-host').MkadocPlugin }[], declarations: PluginDeclaration[] }} acc
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 */
async function resolveDeclarations(acc, host) {
  const { declarations } = acc
  if (!declarations.length) return

  // Coverage: fail fast, listing every missing non-optional dependency.
  const missing = []
  for (const declaration of declarations) {
    for (const { name, optional } of declaration.deps) {
      if (optional || host.hasDep(name)) continue
      missing.push(`  - ${declaration.owner} depends on "${name}", which no loaded plugin provides`)
    }
  }
  if (missing.length) {
    throw new Error(`mkadoc: plugin dependency check failed:\n${missing.join('\n')}`)
  }

  // Run the needed providers once each (registry memoizes), in parallel —
  // provider factories have no dependencies, so resolution order is free.
  const needed = new Set()
  for (const declaration of declarations) {
    for (const { name } of declaration.deps) {
      if (host.hasDep(name)) needed.add(name)
    }
  }
  const values = {}
  await Promise.all(
    [...needed].map(async (name) => {
      values[name] = await host.resolveDep(name)
    }),
  )

  // Create plugin objects in config order (declaration order) — chrome order
  // is preserved regardless of the dependency graph. Values are passed
  // positionally, in declared order (registry names may contain hyphens).
  for (const declaration of declarations) {
    const args = declaration.deps.map(({ name, optional }) =>
      optional && !(name in values) ? undefined : values[name],
    )
    const plugin = await declaration.create(...args)
    if (!plugin || typeof plugin !== 'object') {
      throw new Error(
        `mkadoc: plugin "${declaration.owner}" create() must return a plugin object (got ${typeof plugin})`,
      )
    }
    plugin.locator = declaration.owner
    acc.loaded.push({ locator: declaration.owner, plugin })
  }
}

/**
 * @param {{ locator: string, plugin: import('@mkadoc/plugin-host').MkadocPlugin }[]} loaded
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 */
function createPluginRunner(loaded, host) {
  return {
    list: loaded,

    /**
     * @param {import('@mkadoc/plugin-host').BuildContext} ctx
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

    /**
     * Release plugin-owned resources in reverse load order (consumers before
     * providers), then flip the host to `disposed` so service lookups fail
     * loudly afterwards.
     */
    async dispose() {
      for (let i = loaded.length - 1; i >= 0; i--) {
        const { plugin } = loaded[i]
        if (plugin.dispose) await plugin.dispose(host)
      }
      host.setPhase('disposed')
    },
  }
}

/**
 * @param {Record<string, Record<string, unknown>> | null | undefined} pluginsConfig
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 */
export async function loadPlugins(pluginsConfig, host) {
  host.beginLoad()
  try {
    return await loadPluginsInner(pluginsConfig, host)
  } finally {
    // Close the load even on failure: prune partial registrations (releasing
    // their values) and clear the reentrancy guard.
    host.endLoad()
  }
}

async function loadPluginsInner(pluginsConfig, host) {
  const entries = Object.entries(pluginsConfig || {})
  const configured = new Set(entries.map(([locator]) => locator))
  // Config order first (chrome order), then any unlisted built-in renderers.
  const ordered = [
    ...entries.map(([locator]) => locator),
    ...AUTO_RENDERERS.filter((locator) => !configured.has(locator)),
  ]

  const optionsFor = (locator) => entries.find(([k]) => k === locator)?.[1] ?? {}

  /** @type {{ locator: string, plugin: import('@mkadoc/plugin-host').MkadocPlugin }[]} */
  const loaded = []
  /** @type {{ owner: string, deps: { name: string, optional: boolean }[], create: (deps: unknown[]) => import('@mkadoc/plugin-host').MkadocPlugin | Promise<import('@mkadoc/plugin-host').MkadocPlugin> }[]} */
  const declarations = []

  // Phase 1 — factories run in config order: options parsed, capabilities
  // declared via host.provide, deps declared via host.plugin. Nothing is
  // executed yet — declarations are cheap and order-independent.
  for (const locator of ordered) {
    const factory = await resolveFactory(locator, host)
    await constructPlugin(locator, factory, optionsFor(locator), host, { loaded, declarations })
  }

  // Phase 2 — resolve the dependency graph, then create plugin objects.
  host.setPhase('resolving')
  await resolveDeclarations({ loaded, declarations }, host)

  // Phase 3 — renderers register + setup before feature plugins so feature
  // plugins can discover them (e.g. mkadoc:nav finds the `.adoc` renderer for
  // _nav.adoc).
  for (const { plugin } of loaded) {
    if (plugin.kind === 'renderer') {
      host.registerRenderer(plugin)
      if (plugin.setup) await plugin.setup(host)
    }
  }
  for (const { plugin } of loaded) {
    if (plugin.kind !== 'renderer' && plugin.setup) await plugin.setup(host)
  }

  // The registry is complete — every provider has run in config order. From
  // here on the load-time phase gate is open.
  host.setPhase('ready')

  return createPluginRunner(loaded, host)
}
