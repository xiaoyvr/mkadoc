import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('site map (core default home)', () => {
  it('generates site/index.html grouped by source with page titles', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
`),
        'docs/index.adoc': '= Home\n',
        'docs/guide.md': '# Guide\n',
        'apps/mkadoc/docs/index.adoc': '= App Home\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })

        const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')
        assert.ok(html.includes('<h2>docs</h2>'))
        assert.ok(html.includes('<h2>apps/mkadoc/docs</h2>'))
        assert.ok(html.includes('href="/docs/index.html">Home</a>'))
        assert.ok(html.includes('href="/docs/guide.html">Guide</a>'))
        assert.ok(html.includes('href="/apps/mkadoc/docs/index.html">App Home</a>'))
      },
    )
  })

  it('is not pruned by stale-page cleanup', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
`),
        'docs/index.adoc': '= Home\n',
        'docs/guide.adoc': '= Guide\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        assert.ok(fs.existsSync(path.join(root, 'site/index.html')))

        // delete a page → incremental rebuild must keep site/index.html
        fs.rmSync(path.join(root, 'docs/guide.adoc'))
        await build(cfg, { paths: ['docs/guide.adoc'] })
        assert.ok(fs.existsSync(path.join(root, 'site/index.html')))
      },
    )
  })
})
