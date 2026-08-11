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
  const configAbs = path.resolve(current.root, configPath)
  const configDir = path.dirname(configAbs)
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
  // Drop FS events while a build is writing output, plus a short settle window
  // afterward so copy/write noise cannot schedule a follow-up rebuild.
  let ignoreUntil = 0

  async function reloadConfigIfNeeded(paths) {
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
    ignoreUntil = Number.POSITIVE_INFINITY
    try {
      await reloadConfigIfNeeded(paths)
      // Config edits always force a full rebuild so theme/plugin changes apply.
      const configTouched = paths.some(
        (p) => path.resolve(p) === configAbs || path.resolve(current.root, p) === configAbs,
      )
      await build(
        current,
        configTouched || paths.length === 0
          ? { forceFull: true }
          : { paths },
      )
    } catch (err) {
      console.error('mkadoc: rebuild failed:', err?.message || err)
    } finally {
      building = false
      ignoreUntil = Date.now() + 250
      if (rebuildQueued || pending.size) {
        rebuildQueued = false
        await flush()
      }
    }
  }

  function isWatchedPath(filePath) {
    const abs = path.resolve(filePath)
    if (abs === configAbs) return true
    const rel = path.relative(watchRoot, abs)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  function schedule(filePath) {
    if (Date.now() < ignoreUntil) return
    if (!isWatchedPath(filePath)) return
    const ext = path.extname(filePath).toLowerCase()
    if (ext && !WATCH_EXTS.has(ext)) return
    pending.add(filePath)
    clearTimeout(timer)
    timer = setTimeout(() => {
      flush().catch((err) => console.error(err))
    }, 100)
  }

  // Watch docs/ recursively. Watch the config's parent directory at depth 0
  // (not the file inode) so editor atomic save/rename keeps delivering events.
  const docsWatcher = watch(watchRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: [
      /(^|[/\\])\../, // dotfiles
      '**/node_modules/**',
    ],
  })

  const configWatcher = watch(configDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (p) => {
      const abs = path.resolve(p)
      return abs !== configDir && abs !== configAbs
    },
  })

  const onReady = () => {
    // Log once when both are ready enough; duplicate ready is fine.
    const relConfig = path.relative(current.root, configAbs) || configAbs
    console.log(`mkadoc: watching ${current.source}/ and ${relConfig} only`)
  }
  let readyCount = 0
  const markReady = () => {
    readyCount += 1
    if (readyCount === 2) onReady()
  }

  for (const watcher of [docsWatcher, configWatcher]) {
    watcher.on('ready', markReady)
    watcher.on('error', (err) => {
      console.error('mkadoc: watch error:', err?.message || err)
    })
    watcher.on('add', schedule)
    watcher.on('change', schedule)
    watcher.on('unlink', schedule)
  }

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
      `mkadoc: serving on all interfaces port ${port} (local ${localUrl})`,
    )
  } else {
    console.log(`mkadoc: serving ${localUrl} (local only)`)
  }

  const shutdown = async () => {
    clearTimeout(timer)
    await Promise.all([docsWatcher.close(), configWatcher.close()])
    // live-server doesn't expose a clean stop API; exit the process.
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the event loop alive (live-server already does; this is explicit).
  await new Promise(() => {})
}
