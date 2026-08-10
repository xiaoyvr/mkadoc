import { createRequire } from 'node:module'
import path from 'node:path'
import { watch } from 'chokidar'
import { build } from './build.js'
import { defaultConfigPath, loadConfig, resolveServeListen } from './config.js'

const require = createRequire(import.meta.url)
const liveServer = require('live-server')

const WATCH_EXTS = new Set(['.adoc', '.css', '.js', '.html', '.yml', '.yaml'])

/**
 * @param {object} cfg
 * @param {{ open?: boolean, configPath?: string }} [opts]
 */
export async function serve(cfg, opts = {}) {
  let current = cfg
  const configPath = opts.configPath || cfg.configPath || defaultConfigPath()
  const { host, port, remote } = resolveServeListen(current.serve)
  const outDir = path.join(current.root, current.output)
  const watchRoot = path.join(current.root, current.source)

  console.log('mkadoc: initial full build')
  await build(current, { forceFull: true })

  let timer = null
  /** @type {Set<string>} */
  const pending = new Set()
  let building = false
  let rebuildQueued = false

  async function reloadConfigIfNeeded(paths) {
    const configAbs = path.resolve(current.root, configPath)
    const touched = paths.some(
      (p) => path.resolve(p) === configAbs || path.resolve(current.root, p) === configAbs,
    )
    if (!touched) return
    current = await loadConfig(configPath, current.root)
    console.log('mkadoc: reloaded config')
  }

  async function flush() {
    if (building) {
      rebuildQueued = true
      return
    }
    const paths = [...pending]
    pending.clear()
    building = true
    try {
      await reloadConfigIfNeeded(paths)
      await build(current, paths.length ? { paths } : { forceFull: true })
    } catch (err) {
      console.error('mkadoc: rebuild failed:', err?.message || err)
    } finally {
      building = false
      if (rebuildQueued || pending.size) {
        rebuildQueued = false
        await flush()
      }
    }
  }

  function schedule(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext && !WATCH_EXTS.has(ext)) return
    pending.add(filePath)
    clearTimeout(timer)
    timer = setTimeout(() => {
      flush().catch((err) => console.error(err))
    }, 100)
  }

  const watcher = watch(watchRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: [
      /(^|[/\\])\../, // dotfiles
      '**/node_modules/**',
    ],
  })

  watcher.on('add', schedule)
  watcher.on('change', schedule)
  watcher.on('unlink', schedule)

  // Also watch site config (may live next to sources).
  watcher.add(path.resolve(current.root, configPath))

  liveServer.start({
    root: outDir,
    host,
    port,
    open: opts.open ?? false,
    wait: 200,
    logLevel: 2,
  })

  const localUrl = `http://127.0.0.1:${port}/`
  if (remote) {
    console.log(
      `mkadoc: serving on all interfaces port ${port} (local ${localUrl}, watching ${current.source}/)`,
    )
  } else {
    console.log(`mkadoc: serving ${localUrl} (local only, watching ${current.source}/)`)
  }

  const shutdown = async () => {
    clearTimeout(timer)
    await watcher.close()
    // live-server doesn't expose a clean stop API; exit the process.
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the event loop alive (live-server already does; this is explicit).
  await new Promise(() => {})
}
