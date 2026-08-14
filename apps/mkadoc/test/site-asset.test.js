import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { build } from '../src/build.js'
import { afterPluginsLoaded } from '../src/builtins/shiki.js'
import { loadConfig } from '../src/config.js'
import { resolveSiteAsset } from '../src/fs-utils.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

after(() => {
  afterPluginsLoaded([])
})

describe('resolveSiteAsset', () => {
  it('maps root-absolute hrefs under output/', async () => {
    await withTempProject({}, async (root) => {
      const asset = resolveSiteAsset(root, 'site', '/styles/nav.css')
      assert.equal(asset.href, '/styles/nav.css')
      assert.equal(asset.relPath, 'styles/nav.css')
      assert.equal(asset.absPath, path.join(root, 'site', 'styles', 'nav.css'))
    })
  })

  it('rejects relative, parent, and protocol-relative hrefs', () => {
    assert.throws(() => resolveSiteAsset('/tmp', 'site', 'styles/nav.css'), /root-absolute/)
    assert.throws(() => resolveSiteAsset('/tmp', 'site', '/styles/../evil.css'), /invalid/)
    assert.throws(() => resolveSiteAsset('/tmp', 'site', '//cdn.example/x.css'), /root-absolute/)
    assert.throws(() => resolveSiteAsset('/tmp', 'site', '/'), /invalid/)
  })
})

describe('nav/shiki href write alignment', () => {
  it('nav writes CSS/JS to paths derived from css_href / js_href', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav:
    css_href: /assets/nav.css
    js_href: /assets/nav.js
`),
        'docs/_nav.adoc': `* xref:index.adoc[Home]
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const css = fs.readFileSync(path.join(root, 'site/assets/nav.css'), 'utf8')
        const js = fs.readFileSync(path.join(root, 'site/assets/nav.js'), 'utf8')
        assert.match(css, /\.docs-tabs/)
        assert.match(js, /docs-tab/)
        assert.equal(fs.existsSync(path.join(root, 'site/styles/nav.css')), false)

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /docs-topbar/)
        assert.match(header, /docs-tab/)
        assert.match(header, /Home/)
        assert.match(header, /docs-sidebar/)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/assets\/nav\.css"/)
        assert.match(docinfo, /src="\/assets\/nav\.js"/)
      },
    )
  })

  it('shiki writes CSS to the path derived from css_href', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:shiki:
    theme: github-light-default
    css_href: /assets/shiki.css
`),
        'docs/index.adoc': `= Smoke Index

[source,bash]
----
echo hello
----
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        assert.match(
          fs.readFileSync(path.join(root, 'site/assets/shiki.css'), 'utf8'),
          /Generated from Shiki/,
        )
        assert.equal(fs.existsSync(path.join(root, 'site/styles/shiki.css')), false)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/assets\/shiki\.css"/)
      },
    )
  })
})
