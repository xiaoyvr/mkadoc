import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { parseHtml } from './helpers/html.js'
import { smokeFixture, withTempProject, yamlConfig } from './helpers/project.js'

describe('nav plugin asset href', () => {
  it('writes CSS to /styles/nav.css and contributes the sidebar', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_nav.adoc': '* xref:index.adoc[Home]\n',
        'docs/_theme/nav.css': '.mkadoc-articles a { color: #123456; }\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })

        const navCss = fs.readFileSync(path.join(root, 'site/styles/nav.css'), 'utf8')
        assert.match(navCss, /\.mkadoc-articles a/)
        assert.match(navCss, /#123456/)

        const header = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        const sidebar = header.querySelector('#mkadoc-articles')
        assert.ok(sidebar)
        assert.ok(sidebar.text.includes('Home'))
        assert.equal(header.querySelector('.listingblock'), null)
        assert.ok(!header.toString().includes('#123456'))

        assert.ok(header.querySelector('link[href="/styles/nav.css"]'))
        assert.ok(header.querySelector('script[src="/styles/nav.js"]'))
        // the asset exists and is wired into the head
        assert.ok(fs.existsSync(path.join(root, 'site/styles/nav.js')))
      },
    )
  })
})
