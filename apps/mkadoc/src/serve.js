import path from 'node:path'
import { watch } from 'chokidar'
import { build } from './build.js'
import { defaultConfigPath, loadConfig, resolveServeListen } from './config.js'
import { createDevServer } from './dev-server.js'

const WATCH_EXTS = new Set(['.adoc', '.asciidoc', '.css', '.js', '.html'])

export async function serve(cfg, opts = {}) {
  let current = cfg
  const buildFn = opts.buildFn || build
  const createServer = opts.createServer || createDevServer
  const configPath = opts.configPath || cfg.configPath || defaultConfigPath()
  const configAbs = path.resolve(current.root, configPath)
  const configDir = path.dirname(configAbs)
  const { host, port, remote } = resolveServeListen(current.serve)
  const outDir = path.join(current.root, current.output)
  const watchRoot = path.join(current.root, current.source)

  console.log('mkadoc: initial full build')
  await buildFn(current, { forceFull: true })

  let timer = null
  const pending = new Set()
  let building = false
  let rebuildQueued = false

  let ignoreUntil = 0
  let closed = false

  async function reloadConfigIfNeeded(paths) {
    const touched = paths.some(
      (p) => path.resolve(p) === configAbs || path.resolve(current.root, p) === configAbs,
    )
    if (!touched) return
    current = await loadConfig(configPath, current.root)
    console.log('mkadoc: reloaded config')
  }

  let devServer = null

  async function flush() {
    if (closed) return
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

      const configTouched = paths.some(
        (p) => path.resolve(p) === configAbs || path.resolve(current.root, p) === configAbs,
      )

      if (!configTouched && paths.length === 0) return
      await buildFn(current, configTouched ? { forceFull: true } : { paths })
      devServer?.reload()
    } catch (err) {
      console.error('mkadoc: rebuild failed:', err?.message || err)
    } finally {
      building = false
      ignoreUntil = Date.now() + 250
      if (!closed && (rebuildQueued || pending.size)) {
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
    if (closed) return
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

  const docsWatcher = watch(watchRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: [/(^|[/\\])\../, '**/node_modules/**'],
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

  const watchersReady = new Promise((resolve) => {
    let readyCount = 0
    const markReady = () => {
      readyCount += 1
      if (readyCount === 2) {
        const relConfig = path.relative(current.root, configAbs) || configAbs
        console.log(`mkadoc: watching ${current.source}/ and ${relConfig} only`)
        resolve()
      }
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
  })

  await watchersReady

  devServer = await createServer({
    root: outDir,
    host,
    port,
    open: opts.open ?? false,
  })

  if (remote) {
    console.log(
      `mkadoc: serving on all interfaces port ${port} (local ${devServer.url || `http://127.0.0.1:${port}/`})`,
    )
  } else {
    console.log(`mkadoc: serving ${devServer.url || `http://127.0.0.1:${port}/`} (local only)`)
  }

  async function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    timer = null
    pending.clear()
    rebuildQueued = false
    await Promise.all([
      docsWatcher.close(),
      configWatcher.close(),
      devServer?.close?.() ?? Promise.resolve(),
    ])
  }

  return { close }
}
