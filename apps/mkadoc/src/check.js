import fs from 'node:fs'
import path from 'node:path'
import { loadDependencyGraph } from './deps.js'
import { createHosts } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

export async function check(cfg) {
  let failed = false

  const deps = loadDependencyGraph(cfg.root)
  const { plugin: pluginHost } = createHosts(cfg, { deps })

  let plugins = null
  try {
    plugins = await loadPlugins(cfg.plugins, pluginHost)
  } catch (err) {
    // e.g. a plugin option error or an unresolved dependency — source
    // checks below still run, but per-plugin checks cannot.
    console.error(`mkadoc check: ${err?.message || err}`)
    failed = true
  }

  for (const source of cfg.sources) {
    const abs = path.join(cfg.root, source.path)
    if (!fs.existsSync(abs)) {
      console.error(`mkadoc check: source not found: ${source.path}`)
      failed = true
    } else {
      console.log(`mkadoc check: source ok (${source.path} → ${source.mount})`)
    }
  }

  if (plugins) {
    try {
      const results = await plugins.check()

      for (const result of results) {
        const label = result.locator
        if (result.ok) {
          console.log(`mkadoc check: ${label}: ${result.message || 'ok'}`)
        } else {
          console.error(`mkadoc check: ${label}: ${result.message || 'failed'}`)
          failed = true
        }
      }
    } finally {
      // Honor the plugin lifecycle: release resources (e.g. shiki's
      // highlighter) before the command exits.
      await plugins.dispose()
    }
  }

  if (failed) {
    console.error('mkadoc check: FAILED')
    return 1
  }
  console.log('mkadoc check: OK')
  return 0
}
