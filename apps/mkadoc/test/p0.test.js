import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { createHosts } from '../src/plugin/host.js'
import { smokeFixture, withTempProject } from './helpers/project.js'

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel))
}

describe('P0: orphan HTML prune', () => {
  it('incremental build removes HTML for a deleted page batched with an edit', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })
      assert.ok(exists(root, 'site/docs/guide.html'))
      assert.ok(exists(root, 'site/docs/index.html'))

      fs.rmSync(path.join(root, 'docs/guide.adoc'))
      fs.writeFileSync(path.join(root, 'docs/index.adoc'), `= Smoke Index\n\nMARKER_INDEX_V2\n`)

      // index.adoc forces full (tab chrome is baked into every page)
      const mode = await build(cfg, {
        paths: ['docs/guide.adoc', 'docs/index.adoc'],
      })
      assert.equal(mode, 'full')
      assert.equal(exists(root, 'site/docs/guide.html'), false)
      assert.match(
        fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'),
        /MARKER_INDEX_V2/,
      )
    })
  })
})

describe('P0: publish clean', () => {
  it('clean full build wipes stale output before rebuilding', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      const stale = path.join(root, 'site/stale-orphan.html')
      const staleCache = path.join(root, '.cache/junk.txt')
      fs.writeFileSync(stale, '<p>stale</p>\n')
      fs.mkdirSync(path.dirname(staleCache), { recursive: true })
      fs.writeFileSync(staleCache, 'junk\n')

      await build(cfg, { forceFull: true, clean: true })

      assert.equal(exists(root, 'site/stale-orphan.html'), false)
      assert.equal(exists(root, '.cache/junk.txt'), false)
      assert.ok(exists(root, 'site/docs/index.html'))
      assert.ok(exists(root, 'site/docs/guide.html'))
    })
  })
})

describe('P0: docinfo attribute escaping', () => {
  it('writeHeadDocinfo escapes attribute values', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const { build: host } = createHosts(cfg)
      host.contributeHead({
        links: [
          {
            rel: 'stylesheet',
            href: '/styles/x.css" onload="alert(1)',
          },
        ],
        scripts: [
          {
            src: '/styles/x.js"><img src=x onerror=alert(1)><',
            defer: true,
            'data-x': 'a&b',
          },
        ],
      })
      host.writeHeadDocinfo()

      const body = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
      assert.match(body, /href="\/styles\/x\.css&quot; onload=&quot;alert\(1\)"/)
      assert.match(body, /src="\/styles\/x\.js&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&lt;"/)
      assert.match(body, /data-x="a&amp;b"/)
      assert.doesNotMatch(body, /onload="alert/)
    })
  })
})
