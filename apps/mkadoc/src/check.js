import fs from 'node:fs'
import path from 'node:path'
import { loadDependencyGraph } from './deps.js'
import { createHosts } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

export async function check(cfg) {
  let failed = false

  const deps = loadDependencyGraph(cfg.root)
  const { plugin: pluginHost } = createHosts(cfg, { deps })
  const plugins = await loadPlugins(cfg.plugins, pluginHost)

  for (const source of cfg.sources) {
    const abs = path.join(cfg.root, source.path)
    if (!fs.existsSync(abs)) {
      console.error(`mkadoc check: source not found: ${source.path}`)
      failed = true
    } else {
      console.log(`mkadoc check: source ok (${source.path} → ${source.mount})`)
    }
  }

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

  if (failed) {
    console.error('mkadoc check: FAILED')
    return 1
  }
  console.log('mkadoc check: OK')
  return 0
}
