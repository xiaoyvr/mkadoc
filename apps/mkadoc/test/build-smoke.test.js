import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel))
}

function mtimeMs(root, rel) {
  return fs.statSync(path.join(root, rel)).mtimeMs
}

describe('build smoke (no plugins)', () => {
  it('full build writes expected HTML for pages and skips partials', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const mode = await build(cfg, { forceFull: true })

      assert.equal(mode, 'full')
      assert.ok(exists(root, 'site/docs/index.html'))
      assert.ok(exists(root, 'site/docs/guide.html'))
      assert.equal(exists(root, 'site/_partial.html'), false)
      assert.match(read(root, 'site/docs/index.html'), /MARKER_INDEX_V1/)
      assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V1/)
    })
  })

  it('incremental page rebuild updates only that page', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      const indexBefore = read(root, 'site/docs/index.html')
      const indexMtime = mtimeMs(root, 'site/docs/index.html')

      fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)
      await new Promise((r) => setTimeout(r, 20))

      const mode = await build(cfg, { paths: [path.join(root, 'docs/guide.adoc')] })
      assert.equal(mode, 'incremental')
      assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
      assert.equal(read(root, 'site/docs/index.html'), indexBefore)
      assert.equal(mtimeMs(root, 'site/docs/index.html'), indexMtime)
    })
  })

  it('index.adoc in a batch forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      fs.writeFileSync(path.join(root, 'docs/index.adoc'), `= Smoke Index\n\nMARKER_INDEX_V2\n`)
      fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)
      const mode = await build(cfg, { paths: ['docs/index.adoc', 'docs/guide.adoc'] })
      assert.equal(mode, 'full')
      assert.match(read(root, 'site/docs/index.html'), /MARKER_INDEX_V2/)
      assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
    })
  })

  it('multiple non-index page paths rebuild incrementally', async () => {
    await withTempProject(
      smokeFixture({
        'docs/other.adoc': `= Smoke Other\n\nMARKER_OTHER_V1\n`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)
        fs.writeFileSync(path.join(root, 'docs/other.adoc'), `= Smoke Other\n\nMARKER_OTHER_V2\n`)
        const mode = await build(cfg, { paths: ['docs/guide.adoc', 'docs/other.adoc'] })
        assert.equal(mode, 'incremental')
        assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
        assert.match(read(root, 'site/docs/other.html'), /MARKER_OTHER_V2/)
      },
    )
  })

  it('unknown non-page path alone forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })
      const mode = await build(cfg, { paths: ['README.md'] })
      assert.equal(mode, 'full')
    })
  })

  it('config path change forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })
      const mode = await build(cfg, { paths: ['mkadoc.adoc'] })
      assert.equal(mode, 'full')
    })
  })

  it('underscore partial change forces a full rebuild', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      const mode = await build(cfg, { paths: ['docs/_partial.adoc'] })
      assert.equal(mode, 'full')
      assert.match(read(root, 'site/docs/index.html'), /MARKER_INDEX_V1/)
      assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V1/)
    })
  })

  it('styles-only change is assets mode and leaves HTML untouched', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      const indexBefore = read(root, 'site/docs/index.html')
      const guideBefore = read(root, 'site/docs/guide.html')
      assert.match(read(root, 'site/styles/site.css'), /site css v1/)

      fs.writeFileSync(path.join(root, 'docs/styles/site.css'), `/* site css v2 */\n`)
      const mode = await build(cfg, { paths: ['docs/styles/site.css'] })
      assert.equal(mode, 'assets')
      assert.equal(read(root, 'site/docs/index.html'), indexBefore)
      assert.equal(read(root, 'site/docs/guide.html'), guideBefore)
      assert.match(read(root, 'site/styles/site.css'), /site css v2/)
    })
  })

  it('incremental page + styles still copies updated CSS', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)
      fs.writeFileSync(path.join(root, 'docs/styles/site.css'), `/* site css mixed */\n`)

      const mode = await build(cfg, {
        paths: ['docs/guide.adoc', 'docs/styles/site.css'],
      })
      assert.equal(mode, 'incremental')
      assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
      assert.match(read(root, 'site/styles/site.css'), /site css mixed/)
    })
  })

  it('incremental page + configured assets still copies the asset', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
assets:
  - from: static
    to: site/static
plugins: {}
`),
        'static/app.js': `console.log('v1')\n`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        assert.match(read(root, 'site/static/app.js'), /v1/)

        fs.writeFileSync(path.join(root, 'docs/guide.adoc'), `= Smoke Guide\n\nMARKER_GUIDE_V2\n`)
        fs.writeFileSync(path.join(root, 'static/app.js'), `console.log('v2')\n`)

        const mode = await build(cfg, {
          paths: ['docs/guide.adoc', 'static/app.js'],
        })
        // Unknown non-page paths do not force full when real pages are also present.
        assert.equal(mode, 'incremental')
        assert.match(read(root, 'site/docs/guide.html'), /MARKER_GUIDE_V2/)
        assert.match(read(root, 'site/static/app.js'), /v2/)
      },
    )
  })
})
