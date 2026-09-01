import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { serve } from '../src/serve.js'
import { sleep, smokeFixture, waitFor, withTempProject, yamlConfig } from './helpers/project.js'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 * @param {object} cfg
 */
async function startServe(cfg) {
  /** @type {{ opts: object, mode: string }[]} */
  const calls = []
  /** @type {{ opts: object | null }} stable holder — `opts` updates when serve recreates the server */
  const server = { opts: null }
  const { close } = await serve(cfg, {
    createServer: async (opts) => {
      server.opts = opts
      return {
        close: async () => {},
        reload: () => {},
        url: 'http://127.0.0.1:0/',
      }
    },
    buildFn: async (c, opts) => {
      const mode = await build(c, opts)
      calls.push({ opts, mode })
      return mode
    },
  })
  return { close, calls, server }
}

describe('serve smoke (watch → build wiring)', () => {
  it('starts with a full build', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      const { close, calls } = await startServe(cfg)
      try {
        assert.equal(calls.length, 1)
        assert.equal(calls[0].opts.forceFull, true)
        assert.ok(calls[0].opts.watchExts instanceof Set)
        assert.ok(
          calls[0].opts.watchExts.has('.adoc'),
          'renderer extensions populate the watcher set',
        )
        assert.equal(calls[0].mode, 'full')
        assert.match(read(root, 'site/docs/index.html'), /MARKER_INDEX_V1/)
      } finally {
        await close()
      }
    })
  })

  it('page edit triggers incremental rebuild via paths', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
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
        assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
      } finally {
        await close()
      }
    })
  })

  it('passes the nav-owned root redirect (first nav item)', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_nav.yaml': '- page: index\n- page: guide\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        const { close, server } = await startServe(cfg)
        try {
          assert.equal(typeof server.opts.rootRedirect, 'function')
          assert.equal(server.opts.rootRedirect(), '/docs/index.html')
        } finally {
          await close()
        }
      },
    )
  })

  it('has no root redirect when nav is disabled', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      const { close, server } = await startServe(cfg)
      try {
        assert.equal(server.opts.rootRedirect(), null)
      } finally {
        await close()
      }
    })
  })

  it('config edit forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      const { close, calls } = await startServe(cfg)
      try {
        await sleep(400)
        const configPath = path.join(root, 'mkadoc.yaml')
        fs.writeFileSync(
          configPath,
          fs.readFileSync(configPath, 'utf8').replace('port: 8765', 'port: 8766'),
        )

        await waitFor(() => calls.length >= 2)
        assert.equal(calls[1].opts.forceFull, true)
        assert.equal(calls[1].mode, 'full')
      } finally {
        await close()
      }
    })
  })

  it('recreates watchers + dev server when sources/output change under serve', async () => {
    await withTempProject(
      smokeFixture({
        'docs2/index.md': '# Two\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        const { close, calls, server } = await startServe(cfg)
        try {
          await sleep(400)
          assert.equal(server.opts.root, path.join(root, 'site'))

          // config change: add a source + move the output dir
          fs.writeFileSync(
            path.join(root, 'mkadoc.yaml'),
            yamlConfig(`sources:
  - docs
  - docs2
output: site2
`),
          )
          await waitFor(() => calls.length >= 2)
          assert.equal(calls[1].opts.forceFull, true)
          assert.equal(
            server.opts.root,
            path.join(root, 'site2'),
            'dev server follows the new output',
          )

          // the newly added source is now watched: an edit there rebuilds
          await sleep(400)
          fs.writeFileSync(path.join(root, 'docs2/index.md'), '# Two\n\nMARKER_TWO_V2\n')
          await waitFor(() => calls.length >= 3)
          const third = calls[2]
          assert.ok(
            third.opts.paths.some((p) => String(p).replace(/\\/g, '/').endsWith('docs2/index.md')),
            'edit in the added source is watched',
          )
          assert.equal(third.mode, 'incremental')
          assert.match(read(root, 'site2/docs2/index.html'), /MARKER_TWO_V2/)
        } finally {
          await close()
        }
      },
    )
  })

  it('excludes the output dir from the watcher (no rebuild livelock)', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.yaml': yamlConfig(`sources:\n  - docs\noutput: docs/_site\n`),
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        const { close, calls } = await startServe(cfg)
        try {
          await sleep(400)
          // sanity: an edit under the source still rebuilds
          fs.writeFileSync(path.join(root, 'docs/index.adoc'), `= Smoke Index\n\nMARKER_INDEX_V3\n`)
          await waitFor(() => calls.length >= 2)

          // let the post-flush ignoreUntil window lapse, then write into the
          // output dir (docs/_site lives inside the watched docs source) —
          // without the explicit exclusion this schedules another rebuild.
          await sleep(400)
          const count = calls.length
          fs.appendFileSync(path.join(root, 'docs/_site/docs/index.html'), '\n<!-- touched -->\n')
          await sleep(700)
          assert.equal(calls.length, count, 'output-dir writes must not trigger rebuilds')
        } finally {
          await close()
        }
      },
    )
  })

  it('ignores extensionless files (no rebuild on edit)', async () => {
    await withTempProject(smokeFixture({ 'docs/LICENSE': 'MIT\n' }), async (root) => {
      const cfg = await loadConfig('mkadoc.yaml', root)
      const { close, calls } = await startServe(cfg)
      try {
        await sleep(400)
        const count = calls.length
        fs.writeFileSync(path.join(root, 'docs/LICENSE'), 'MIT\n\nupdated\n')
        await sleep(700)
        assert.equal(calls.length, count, 'extensionless file edits must not trigger rebuilds')
      } finally {
        await close()
      }
    })
  })
})
