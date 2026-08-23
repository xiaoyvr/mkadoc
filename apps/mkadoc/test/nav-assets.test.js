import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { extractMkadocCss } from '../src/chrome.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

describe('extractMkadocCss', () => {
  it('extracts [mkadoc-css] blocks', async () => {
    const { css } = await extractMkadocCss(`* xref:index.adoc[Home]

[mkadoc-css]
----
.mkadoc-articles a { color: red; }
----
`)
    assert.equal(css, '.mkadoc-articles a { color: red; }')
  })

  it('returns empty css when no [mkadoc-css] blocks', async () => {
    const { css } = await extractMkadocCss('* xref:index.adoc[Home]\n')
    assert.equal(css, '')
  })
})

describe('nav plugin asset href', () => {
  it('writes CSS to /styles/nav.css and contributes the sidebar', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_nav.adoc': `* xref:index.adoc[Home]

[mkadoc-css]
----
.mkadoc-articles a { color: #123456; }
----
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const navCss = fs.readFileSync(path.join(root, 'site/styles/nav.css'), 'utf8')
        assert.match(navCss, /\.mkadoc-articles a/)
        assert.match(navCss, /#123456/)

        const chromeCss = fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8')
        assert.doesNotMatch(chromeCss, /#123456/)

        const header = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo-header.html'), 'utf8'),
        )
        const sidebar = header.querySelector('#mkadoc-articles')
        assert.ok(sidebar)
        assert.ok(sidebar.text.includes('Home'))
        assert.equal(header.querySelector('.listingblock'), null)
        assert.ok(!header.toString().includes('#123456'))

        const docinfo = parseHtml(
          fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8'),
        )
        assert.ok(docinfo.querySelector('link[href="/styles/nav.css"]'))
        assert.ok(docinfo.querySelector('script[src="/styles/nav.js"]'))
        // extraction succeeded: the asset exists and is wired into the head
        assert.ok(fs.existsSync(path.join(root, 'site/styles/nav.js')))
      },
    )
  })
})
