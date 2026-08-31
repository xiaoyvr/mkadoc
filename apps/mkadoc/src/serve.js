import path from 'node:path'
import { watch } from 'chokidar'
import { build } from './build.js'
import { defaultConfigPath, loadConfig, resolveServeListen } from './config.js'
import { createDevServer } from './dev-server.js'
import { createSession } from './session.js'
import { sourceForRepoPath } from './sources.js'

const CORE_WATCH_EXTS = new Set(['.css', '.js', '.html', '.yaml', '.yml'])

export async function serve(cfg, opts = {}) {
  // One session for the whole serve lifecycle: rebuilds share the dependency
  // registry memoization (e.g. shiki's highlighter) and plugin disposal
  // bookkeeping. See src/session.js.
  const session = opts.session ?? createSession()
  let current = cfg
  const buildFn = opts.buildFn || build
  const createServer = opts.createServer || createDevServer
  const configPath = opts.configPath || cfg.configPath || defaultConfigPath()
  const configAbs = path.resolve(current.root, configPath)
  const configDir = path.dirname(configAbs)
  const { host, port, remote } = resolveServeListen(current.serve)

  // Core-owned extensions plus every loaded renderer's extensions — build()
  // populates the set on each pass, so a new renderer format is watched
  // without core knowing its extensions.
  const watchExts = new Set(CORE_WATCH_EXTS)

  console.log('mkadoc: initial full build')
  await buildFn(current, { forceFull: true, watchExts, session })

  let timer = null
  const pending = new Set()
  let building = false
  let rebuildQueued = false

  let ignoreUntil = 0
  let closed = false

  let devServer = null
  let allWatchers = []
  /** Sources/output the current watchers + dev server were created for. */
  let infraFor = null

  async function reloadConfigIfNeeded(paths) {
    const touched = paths.some(
      (p) => path.resolve(p) === configAbs || path.resolve(current.root, p) === configAbs,
    )
    if (!touched) return
    current = await loadConfig(configPath, current.root)
    console.log('mkadoc: reloaded config')
  }

  /** Do the current watchers + dev server match the (possibly reloaded) config? */
  function infrastructureNeedsReset() {
    const sourcesKey = current.sources.map((s) => s.path).join('\0')
    return !infraFor || infraFor.sourcesKey !== sourcesKey || infraFor.output !== current.output
  }

  function attachWatcherHandlers(watcher) {
    watcher.on('error', (err) => {
      console.error('mkadoc: watch error:', err?.message || err)
    })
    watcher.on('add', schedule)
    watcher.on('change', schedule)
    watcher.on('unlink', schedule)
  }

  /**
   * (Re)create the source watchers + config watcher + dev server from the
   * current config. Called once at startup and again when a config change
   * alters `sources:` or `output:` — otherwise the rebuild would use the new
   * config while watching/serving stale paths.
   * @param {{ announce?: boolean }} [opts]
   */
  async function syncInfrastructure({ announce = false } = {}) {
    if (allWatchers.length) await Promise.all(allWatchers.map((w) => w.close()))

    const outAbs = path.resolve(current.root, current.output)
    // Rebuild writes under output/ must not fire the watcher (output may live
    // inside a watched source, e.g. docs/_site) — exclude it explicitly
    // instead of relying on the post-flush ignoreUntil timing window.
    const isOutputPath = (p) => {
      const abs = path.resolve(p)
      return abs === outAbs || abs.startsWith(outAbs + path.sep)
    }

    const sourceWatchers = current.sources.map((source, index) =>
      watch(path.join(current.root, source.path), {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        ignored: [
          /(^|[/\\])\../,
          '**/node_modules/**',
          isOutputPath,
          // Only the first source owns _theme/ (theme/topbar/nav overrides) —
          // other sources' _theme is read by nothing, so leave it alone: don't
          // watch it at all.
          ...(index > 0 ? ['**/_theme/**', '**/_theme'] : []),
        ],
      }),
    )
    const configWatcher = watch(configDir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored: (p) => {
        const abs = path.resolve(p)
        return abs !== configDir && abs !== configAbs
      },
    })
    allWatchers = [...sourceWatchers, configWatcher]
    for (const watcher of allWatchers) attachWatcherHandlers(watcher)

    await new Promise((resolve) => {
      let readyCount = 0
      for (const watcher of allWatchers) {
        watcher.once('ready', () => {
          readyCount += 1
          if (readyCount === allWatchers.length) resolve()
        })
      }
    })

    if (devServer) await devServer.close?.()
    const outDir = path.join(current.root, current.output)
    devServer = await createServer({
      root: outDir,
      host,
      port,
      open: opts.open ?? false,
      rootRedirect: () => current.rootRedirect?.() ?? null,
    })

    infraFor = {
      sourcesKey: current.sources.map((s) => s.path).join('\0'),
      output: current.output,
    }

    if (announce) {
      const relConfig = path.relative(current.root, configAbs) || configAbs
      const srcList = current.sources.map((s) => s.path).join(', ')
      console.log(`mkadoc: watching ${srcList} and ${relConfig}`)
      if (remote) {
        console.log(
          `mkadoc: serving on all interfaces port ${port} (local ${devServer.url || `http://127.0.0.1:${port}/`})`,
        )
      } else {
        console.log(`mkadoc: serving ${devServer.url || `http://127.0.0.1:${port}/`} (local only)`)
      }
    } else {
      console.log('mkadoc: restarted watchers + dev server (config changed)')
    }
  }

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
      if (configTouched && infrastructureNeedsReset()) {
        await syncInfrastructure()
      }
      await buildFn(
        current,
        configTouched ? { forceFull: true, watchExts, session } : { paths, watchExts, session },
      )
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
    // Output writes are ignored (defense in depth — chokidar already ignores
    // the output dir in the source watchers).
    const outAbs = path.resolve(current.root, current.output)
    if (abs === outAbs || abs.startsWith(outAbs + path.sep)) return false
    const rel = path.relative(current.root, abs).split(path.sep).join('/')
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false
    const source = sourceForRepoPath(current.sources, rel)
    if (!source) return false
    // Non-first sources' _theme is not watched (chokidar ignores it above) —
    // keep the event gate consistent as defense in depth.
    return !(source !== current.sources[0] && rel.split('/').includes('_theme'))
  }

  function schedule(filePath) {
    if (closed) return
    if (Date.now() < ignoreUntil) return
    if (!isWatchedPath(filePath)) return
    const ext = path.extname(filePath).toLowerCase()
    if (ext && !watchExts.has(ext)) return
    pending.add(filePath)
    clearTimeout(timer)
    timer = setTimeout(() => {
      flush().catch((err) => console.error(err))
    }, 100)
  }

  await syncInfrastructure({ announce: true })

  async function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    timer = null
    pending.clear()
    rebuildQueued = false
    await Promise.all([
      ...allWatchers.map((w) => w.close()),
      devServer?.close?.() ?? Promise.resolve(),
    ])
  }

  return { close }
}
