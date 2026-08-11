import { parseArgs } from 'node:util'
import { build } from './build.js'
import { check } from './check.js'
import { defaultConfigPath, loadConfig, parsePort } from './config.js'
import { formatCliError } from './errors.js'
import { serve } from './serve.js'

const HELP = `mkadoc — build and serve AsciiDoc as a static site

Usage:
  mkadoc build [--full] [--config PATH] [PATH...]
  mkadoc publish [--config PATH]
  mkadoc serve [--config PATH] [--port PORT] [--remote] [--open]
  mkadoc check [--config PATH]
  mkadoc help

Config:
  default mkadoc.adoc (literate AsciiDoc; [mkadoc-config] YAML blocks merged in memory)
  --config PATH also accepts .yml / .yaml

Commands:
  build     Convert sources (incremental when PATH args are given)
  publish   Clean full build for deployment
  serve     Full build, watch sources, serve output with live reload
  check     Verify source path and enabled plugin health checks

Serve bind:
  default / remote: false → 127.0.0.1 (local only)
  --remote / remote: true → 0.0.0.0 (LAN / remote access)
  port from config or --port (default 8000)
`

function printHelp() {
  process.stdout.write(HELP)
}

async function cmdBuild(cfg, values, positionals) {
  await build(cfg, {
    forceFull: Boolean(values.full),
    paths: positionals,
  })
}

async function cmdPublish(cfg) {
  await build(cfg, { forceFull: true, clean: true })
}

async function cmdServe(cfg, values) {
  const { close } = await serve(cfg, {
    open: Boolean(values.open),
    configPath: values.config || defaultConfigPath(),
  })

  await new Promise((resolve) => {
    const shutdown = () => {
      close()
        .catch((err) => console.error(err))
        .finally(resolve)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

/**
 * @returns {Promise<number>}
 */
async function main() {
  // Nix shells set SOURCE_DATE_EPOCH for reproducibility; Asciidoctor would
  // then stamp every page with that fixed time. Drop it so the HTML footer
  // uses each .adoc file's real mtime.
  delete process.env.SOURCE_DATE_EPOCH

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      full: { type: 'boolean', default: false },
      config: { type: 'string', short: 'c' },
      port: { type: 'string' },
      remote: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const [command = 'help', ...rest] = positionals

  if (values.help || command === 'help' || command === '--help') {
    printHelp()
    return 0
  }

  const root = process.cwd()
  const configPath = values.config || defaultConfigPath()
  const cfg = await loadConfig(configPath, root)

  // CLI overrides (serve)
  if (values.remote) cfg.serve.remote = true
  if (values.port !== undefined) cfg.serve.port = parsePort(values.port, '--port')

  switch (command) {
    case 'build':
      await cmdBuild(cfg, values, rest)
      return 0
    case 'publish':
      await cmdPublish(cfg)
      return 0
    case 'serve':
      await cmdServe(cfg, values)
      return 0
    case 'check':
      return check(cfg)
    default:
      console.error(`mkadoc: unknown command: ${command}`)
      printHelp()
      return 2
  }
}

main()
  .then((code) => {
    if (code) process.exit(code)
  })
  .catch((err) => {
    // User errors (bad config/args/convert): message only. Unexpected: full stack.
    console.error(formatCliError(err))
    process.exit(1)
  })
