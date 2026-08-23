import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { resolveSiteAsset } from '../src/fs-utils.js'
import { parseHtml } from './helpers/html.js'
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

describe('topbar site logo', () => {
  it('uses package default logo linked to first-source home', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:topbar: {}
`),
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        const logo = header.querySelector('a.mkadoc-logo')
        assert.ok(logo)
        assert.equal(logo.getAttribute('href'), '/docs/index.html')
        assert.equal(logo.querySelector('img')?.getAttribute('src'), '/styles/default-logo.svg')
        assert.ok(fs.existsSync(path.join(root, 'site/styles/default-logo.svg')))
      },
    )
  })

  it('overrides with first-source _assets/logo.svg then logo.png', async () => {
    const topbarConfig = `sources:
  - docs
output: site
plugins:
  mkadoc:topbar: {}
`
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(topbarConfig),
        'docs/_assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'docs/_assets/logo.png': 'PNG',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        assert.equal(
          header.querySelector('a.mkadoc-logo img')?.getAttribute('src'),
          '/docs/_assets/logo.svg',
        )
      },
    )

    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(topbarConfig),
        'docs/_assets/logo.png': 'PNG',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        assert.equal(
          header.querySelector('a.mkadoc-logo img')?.getAttribute('src'),
          '/docs/_assets/logo.png',
        )
      },
    )
  })
})

describe('core chrome href write alignment', () => {
  it('mkadoc:topbar writes /styles/topbar.* and propagates _chrome.adoc overrides', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:topbar: {}
`),
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

        const topbarCss = fs.readFileSync(path.join(root, 'site/styles/topbar.css'), 'utf8')
        // the _chrome.adoc override must propagate into the generated stylesheet
        assert.match(topbarCss, /height: 2rem/)

        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        assert.ok(header.querySelector('#mkadoc-topbar'))
        assert.ok(header.querySelector('a.mkadoc-logo'))
        // no nav plugin → no source bar, no article sidebar
        assert.equal(header.querySelector('a.mkadoc-source'), null)
        assert.equal(header.querySelector('#mkadoc-articles'), null)
        assert.equal(header.querySelector('.listingblock'), null)

        const docinfo = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8'),
        )
        assert.ok(docinfo.querySelector('link[href="/styles/topbar.css"]'))
        assert.ok(docinfo.querySelector('script[src="/styles/topbar.js"]'))
        // core no longer ships its own chrome assets
        assert.equal(fs.existsSync(path.join(root, 'site/styles/chrome.css')), false)
        assert.ok(fs.existsSync(path.join(root, 'site/styles/default-logo.svg')))
      },
    )
  })

  it('mkadoc:nav renders the source bar and article sidebar', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins:
  mkadoc:topbar: {}
  mkadoc:nav: {}
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

        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        assert.ok(header.querySelector('#mkadoc-topbar'))
        assert.deepEqual(
          header.querySelectorAll('a.mkadoc-source').map((el) => el.text.trim()),
          ['Site', 'mkadoc'],
        )
        assert.ok(header.querySelector('#mkadoc-articles'))
        assert.ok(fs.existsSync(path.join(root, 'site/styles/topbar.js')))
        assert.ok(fs.existsSync(path.join(root, 'site/styles/nav.css')))
      },
    )
  })
})
