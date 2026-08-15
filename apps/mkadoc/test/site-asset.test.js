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
      const asset = resolveSiteAsset(root, 'site', '/styles/chrome.css')
      assert.equal(asset.href, '/styles/chrome.css')
      assert.equal(asset.relPath, 'styles/chrome.css')
      assert.equal(asset.absPath, path.join(root, 'site', 'styles', 'chrome.css'))
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
  it('core chrome writes CSS/JS under /styles/chrome.*', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_chrome.adoc': `
[mkadoc-css]
////
.mkadoc-topbar { height: 2rem; }
////
`,
        'docs/_nav.adoc': `* xref:index.adoc[Home]

[mkadoc-css]
////
.mkadoc-sidebar a { color: #123456; }
////
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const chromeCss = fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8')
        const navCss = fs.readFileSync(path.join(root, 'site/styles/nav.css'), 'utf8')
        const js = fs.readFileSync(path.join(root, 'site/styles/chrome.js'), 'utf8')
        assert.match(chromeCss, /--mkadoc-topbar-height/)
        assert.match(chromeCss, /height: 2rem/)
        assert.doesNotMatch(chromeCss, /#123456/)
        assert.match(navCss, /\.mkadoc-sidebar a/)
        assert.match(navCss, /#123456/)
        assert.match(js, /mkadoc-tab/)

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /mkadoc-topbar/)
        assert.match(header, /mkadoc-tab/)
        assert.match(header, /mkadoc-chrome-body/)
        assert.match(header, /Home/)
        assert.match(header, /mkadoc-sidebar/)
        assert.doesNotMatch(header, /listingblock/)
        assert.doesNotMatch(header, /#123456/)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/styles\/chrome\.css"/)
        assert.match(docinfo, /href="\/styles\/nav\.css"/)
        assert.match(docinfo, /src="\/styles\/chrome\.js"/)
      },
    )
  })

  it('core writes section tabs without mkadoc:nav', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins: {}
`),
        'docs/index.adoc': `= Dotfiles
:tab: Site

Root.
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc

App.
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /mkadoc-topbar/)
        assert.match(header, /mkadoc-tab/)
        assert.match(header, /mkadoc-chrome-body/)
        assert.match(header, />Site</)
        assert.match(header, />mkadoc</)
        assert.doesNotMatch(header, /mkadoc-sidebar/)
        assert.ok(fs.existsSync(path.join(root, 'site/styles/chrome.js')))
        assert.match(
          fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8'),
          /\.mkadoc-topbar/,
        )
        assert.doesNotMatch(
          fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8'),
          /\.mkadoc-sidebar/,
        )
        assert.equal(fs.existsSync(path.join(root, 'site/styles/nav.css')), false)
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
