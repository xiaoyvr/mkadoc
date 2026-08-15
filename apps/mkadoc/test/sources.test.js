import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { mountFromSourcePath, pageToOutRel, sourceForPathname } from '../src/sources.js'
import { literateConfig, withTempProject } from './helpers/project.js'

describe('mountFromSourcePath', () => {
  it('maps docs trees to mounts', () => {
    assert.equal(mountFromSourcePath('docs'), '/')
    assert.equal(mountFromSourcePath('apps/mkadoc/docs'), '/apps/mkadoc')
    assert.equal(mountFromSourcePath('modules/home/docs'), '/modules/home')
    assert.equal(mountFromSourcePath('notes'), '/notes')
  })
})

describe('multi-source build', () => {
  it('writes pages under convention mounts and builds tab chrome', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.adoc': `= Dotfiles
:tab: Site

Root body.
`,
        'docs/_nav.adoc': `* xref:index.adoc[Home]

[mkadoc-css]
----
.mkadoc-sidebar a { color: #111; }
----
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc

App body.
`,
        'apps/mkadoc/docs/guide.adoc': `= Guide

Guide body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        assert.equal(cfg.sources[0].title, 'Site')
        assert.equal(cfg.sources[1].title, 'mkadoc')
        assert.equal(cfg.sources[1].mount, '/apps/mkadoc')

        await build(cfg, { forceFull: true })

        assert.ok(fs.existsSync(path.join(root, 'site/index.html')))
        assert.ok(fs.existsSync(path.join(root, 'site/apps/mkadoc/index.html')))
        assert.ok(fs.existsSync(path.join(root, 'site/apps/mkadoc/guide.html')))

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /mkadoc-topbar/)
        assert.match(header, /data-mount="\/"/)
        assert.match(header, /data-mount="\/apps\/mkadoc"/)
        assert.match(header, />Site</)
        assert.match(header, />mkadoc</)
        assert.match(header, /mkadoc-chrome-body/)
        assert.match(header, /mkadoc-sidebar/)

        const outRel = pageToOutRel(cfg.sources[1], 'apps/mkadoc/docs/guide.adoc')
        assert.equal(outRel, 'apps/mkadoc/guide.html')
        assert.equal(
          sourceForPathname(cfg.sources, '/apps/mkadoc/guide.html')?.path,
          'apps/mkadoc/docs',
        )
      },
    )
  })

  it('auto-nav when _nav.adoc is missing', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.adoc': '= Site\n\nHi.\n',
        'docs/other.adoc': '= Other\n\nThere.\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /href="\/index\.html"/)
        assert.match(header, /href="\/other\.html"/)
      },
    )
  })

  it('index.adoc :tab: change refreshes tab chrome', async () => {
    await withTempProject(
      {
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/index.adoc': `= Dotfiles
:tab: Site

Root.
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc

App.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        assert.match(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
          />mkadoc</,
        )

        fs.writeFileSync(
          path.join(root, 'apps/mkadoc/docs/index.adoc'),
          `= mkadoc
:tab: Mkadocx

App.
`,
        )

        const mode = await build(cfg, { paths: ['apps/mkadoc/docs/index.adoc'] })
        assert.equal(mode, 'full')
        assert.equal(cfg.sources[1].title, 'Mkadocx')
        assert.match(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
          />Mkadocx</,
        )
        assert.match(
          fs.readFileSync(path.join(root, 'site/apps/mkadoc/index.html'), 'utf8'),
          />Mkadocx</,
        )
        assert.match(fs.readFileSync(path.join(root, 'site/index.html'), 'utf8'), />Mkadocx</)
        // Page <title> still follows doctitle / :title:, not :tab:
        assert.match(
          fs.readFileSync(path.join(root, 'site/apps/mkadoc/index.html'), 'utf8'),
          /<title>mkadoc<\/title>/,
        )
      },
    )
  })
})
