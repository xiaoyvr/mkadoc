import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { serve } from '../src/serve.js'
import { sleep, smokeFixture, waitFor, withTempProject } from './helpers/project.js'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 * @param {object} cfg
 */
async function startServe(cfg) {
  /** @type {{ opts: object, mode: string }[]} */
  const calls = []
  const { close } = await serve(cfg, {
    createServer: async () => ({
      close: async () => {},
      reload: () => {},
      url: 'http://127.0.0.1:0/',
    }),
    buildFn: async (c, opts) => {
      const mode = await build(c, opts)
      calls.push({ opts, mode })
      return mode
    },
  })
  return { close, calls }
}

describe('serve smoke (watch → build wiring)', () => {
  it('starts with a full build', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yml', root)
      const { close, calls } = await startServe(cfg)
      try {
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].opts, { forceFull: true })
        assert.equal(calls[0].mode, 'full')
        assert.match(read(root, 'site/index.html'), /MARKER_INDEX_V1/)
      } finally {
        await close()
      }
    })
  })

  it('page edit triggers incremental rebuild via paths', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yml', root)
      const { close, calls } = await startServe(cfg)
      try {
        await sleep(400)
        fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)

        await waitFor(() => calls.length >= 2)
        const second = calls[1]
        assert.equal(second.opts.forceFull, undefined)
        assert.ok(Array.isArray(second.opts.paths))
        assert.ok(
          second.opts.paths.some((p) => String(p).replace(/\\/g, '/').endsWith('docs/guide.adoc')),
        )
        assert.equal(second.mode, 'incremental')
        assert.match(read(root, 'site/guide.html'), /MARKER_GUIDE_V2/)
      } finally {
        await close()
      }
    })
  })

  it('config edit forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yml', root)
      const { close, calls } = await startServe(cfg)
      try {
        await sleep(400)
        const configPath = path.join(root, 'mkadoc.yml')
        fs.writeFileSync(
          configPath,
          fs.readFileSync(configPath, 'utf8').replace('port: 8765', 'port: 8766'),
        )

        await waitFor(() => calls.length >= 2)
        assert.deepEqual(calls[1].opts, { forceFull: true })
        assert.equal(calls[1].mode, 'full')
      } finally {
        await close()
      }
    })
  })
})
