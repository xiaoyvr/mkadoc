import { parseArgs } from 'node:util'
import { build } from './build.js'
import { check } from './check.js'
import { defaultConfigPath, loadConfig } from './config.js'
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
  await build(cfg, { forceFull: true })
}

async function cmdServe(cfg, values) {
  await serve(cfg, {
    open: Boolean(values.open),
    configPath: values.config || defaultConfigPath(),
  })
}

async function cmdCheck(cfg) {
  const code = await check(cfg)
  process.exit(code)
}

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
    return
  }

  const root = process.cwd()
  const configPath = values.config || defaultConfigPath()
  const cfg = await loadConfig(configPath, root)

  // CLI overrides (serve)
  if (values.remote) cfg.serve.remote = true
  if (values.port) cfg.serve.port = Number(values.port)

  switch (command) {
    case 'build':
      await cmdBuild(cfg, values, rest)
      break
    case 'publish':
      await cmdPublish(cfg)
      break
    case 'serve':
      await cmdServe(cfg, values)
      break
    case 'check':
      await cmdCheck(cfg)
      break
    default:
      console.error(`mkadoc: unknown command: ${command}`)
      printHelp()
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err?.stack || err)
  process.exit(1)
})
