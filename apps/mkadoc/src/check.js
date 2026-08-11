import fs from 'node:fs'
import path from 'node:path'
import { createHost } from './plugin/host.js'
import { loadPlugins } from './plugin/load.js'

export async function check(cfg) {
  let failed = false

  const source = path.join(cfg.root, cfg.source)
  if (!fs.existsSync(source)) {
    console.error(`mkadoc check: source not found: ${source}`)
    failed = true
  } else {
    console.log(`mkadoc check: source ok (${cfg.source})`)
  }

  const host = createHost(cfg)
  const plugins = await loadPlugins(cfg.plugins, host)
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
