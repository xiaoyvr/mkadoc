import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { resolveSiteAsset } from '../src/fs-utils.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

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

describe('core chrome href write alignment', () => {
  it('core chrome writes CSS/JS under /styles/chrome.*', async () => {
    await withTempProject(
      smokeFixture({
        'docs/_chrome.adoc': `
[mkadoc-css]
----
.mkadoc-topbar { height: 2rem; }
----
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const chromeCss = fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8')
        const js = fs.readFileSync(path.join(root, 'site/styles/chrome.js'), 'utf8')
        assert.match(chromeCss, /--mkadoc-topbar-height/)
        assert.match(chromeCss, /height: 2rem/)
        assert.match(chromeCss, /position: sticky/)
        assert.match(chromeCss, /mkadoc-brand-swap/)
        assert.match(js, /mkadoc-tab/)
        assert.match(js, /getBoundingClientRect/)

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /mkadoc-topbar/)
        assert.match(header, /mkadoc-tab/)
        assert.match(header, /mkadoc-chrome-body/)
        assert.doesNotMatch(header, /mkadoc-sidebar/)
        assert.doesNotMatch(header, /listingblock/)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/styles\/chrome\.css"/)
        assert.match(docinfo, /src="\/styles\/chrome\.js"/)
        assert.equal(fs.existsSync(path.join(root, 'site/styles/nav.css')), false)
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
})
