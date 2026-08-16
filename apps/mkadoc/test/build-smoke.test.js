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

  it('copies referenced local assets to the mirrored output path', async () => {
    const files = {
      'docs/images/pic.png': 'PNG-BLOCK',
      'docs/images/icon.png': 'PNG-INLINE',
      'docs/files/manual.pdf': 'PDF',
      'docs/videos/demo.mp4': 'MP4',
    }
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
`),
        'docs/index.adoc': `= Home

image::images/pic.png[Alt]

Inline image:images/icon.png[] and link:files/manual.pdf[PDF].

video::videos/demo.mp4[]

image::/abs/logo.png[Abs]

image::https://ex.com/x.png[Net]

xref:guide.adoc[Guide]
`,
        'docs/guide.adoc': `= Guide
`,
        ...files,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        for (const [rel, content] of Object.entries(files)) {
          const outRel = `site/${rel}`
          assert.equal(exists(root, outRel), true, `${outRel} should exist`)
          assert.equal(read(root, outRel), content)
        }
        // Absolute and external refs are ignored.
        assert.equal(exists(root, 'site/abs/logo.png'), false)
        assert.equal(exists(root, 'site/docs/x.png'), false)
        // Page links are not assets.
        assert.equal(fs.existsSync(path.join(root, 'site/docs/guide.html')), true)
      },
    )
  })

  it('copies the first source _assets folder to the mirrored output path', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
`),
        'docs/index.adoc': '= Home\n',
        'apps/mkadoc/docs/index.adoc': '= App\n',
        'docs/_assets/logo.png': 'PNG',
        'apps/mkadoc/docs/_assets/other.png': 'IGNORE',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        // First source _assets is staged; other sources are not.
        assert.equal(read(root, 'site/docs/_assets/logo.png'), 'PNG')
        assert.equal(exists(root, 'site/apps/mkadoc/docs/_assets/other.png'), false)
        // _assets is not published as pages.
        assert.equal(exists(root, 'site/docs/_assets/logo.html'), false)
      },
    )
  })

  it('warns and continues on missing referenced assets', async () => {
    const originalWarn = console.warn
    const warnings = []
    console.warn = (msg) => warnings.push(String(msg))
    try {
      await withTempProject(
        {
          'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
`),
          'docs/index.adoc': `= Home

image::images/missing.png[]
`,
        },
        async (root) => {
          const cfg = await loadConfig('mkadoc.adoc', root)
          await build(cfg, { forceFull: true })
        },
      )
    } finally {
      console.warn = originalWarn
    }
    assert.ok(warnings.some((w) => /referenced asset not found/.test(w)))
  })
})
