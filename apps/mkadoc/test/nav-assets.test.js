import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { extractMkadocCss } from '../src/chrome.js'
import { loadConfig } from '../src/config.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

describe('extractMkadocCss', () => {
  it('extracts [mkadoc-css] blocks', async () => {
    const { css } = await extractMkadocCss(`* xref:index.adoc[Home]

[mkadoc-css]
----
.mkadoc-sidebar a { color: red; }
----
`)
    assert.equal(css, '.mkadoc-sidebar a { color: red; }')
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
.mkadoc-sidebar a { color: #123456; }
----
`,
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const navCss = fs.readFileSync(path.join(root, 'site/styles/nav.css'), 'utf8')
        assert.match(navCss, /\.mkadoc-sidebar a/)
        assert.match(navCss, /#123456/)

        const chromeCss = fs.readFileSync(path.join(root, 'site/styles/chrome.css'), 'utf8')
        assert.doesNotMatch(chromeCss, /#123456/)

        const header = fs.readFileSync(
          path.join(root, cfg.docinfoDir, 'docinfo-header.html'),
          'utf8',
        )
        assert.match(header, /mkadoc-sidebar/)
        assert.match(header, /Home/)
        assert.doesNotMatch(header, /listingblock/)
        assert.doesNotMatch(header, /#123456/)

        const docinfo = fs.readFileSync(path.join(root, cfg.docinfoDir, 'docinfo.html'), 'utf8')
        assert.match(docinfo, /href="\/styles\/nav\.css"/)
      },
    )
  })
})
