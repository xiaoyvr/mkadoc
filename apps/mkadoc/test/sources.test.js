import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import {
  mountFromSourcePath,
  pageToOutRel,
  rootRedirectHref,
  sourceForPathname,
} from '../src/sources.js'
import { parseHtml } from './helpers/html.js'
import { withTempProject, yamlConfig } from './helpers/project.js'

describe('mountFromSourcePath', () => {
  it('maps source paths to mounts verbatim', () => {
    assert.equal(mountFromSourcePath('docs'), '/docs')
    assert.equal(mountFromSourcePath('apps/mkadoc/docs'), '/apps/mkadoc/docs')
    assert.equal(mountFromSourcePath('modules/home/docs'), '/modules/home/docs')
    assert.equal(mountFromSourcePath('notes'), '/notes')
  })
})

describe('rootRedirectHref', () => {
  it('redirects the site root to the first source index page', () => {
    assert.equal(
      rootRedirectHref([
        { path: 'docs', mount: '/docs', title: 'Docs' },
        { path: 'apps/mkadoc/docs', mount: '/apps/mkadoc/docs', title: 'mkadoc' },
      ]),
      '/docs/index.html',
    )
  })

  it('returns null when the first source already mounts at root', () => {
    assert.equal(rootRedirectHref([{ path: 'docs', mount: '/', title: 'Docs' }]), null)
  })

  it('returns null when there are no sources', () => {
    assert.equal(rootRedirectHref([]), null)
  })
})

describe('multi-source build', () => {
  it('writes pages under convention mounts and builds source-bar chrome', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins:
  mkadoc:topbar: {}
  mkadoc:nav: {}
`),
        'docs/index.adoc': `= Dotfiles
:nav_label: Site

Root body.
`,
        'docs/_nav.adoc': `* xref:index.adoc[Home]
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc

App body.
`,
        'apps/mkadoc/docs/guide.adoc': `= Guide

Guide body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        assert.equal(cfg.sources[1].mount, '/apps/mkadoc/docs')

        await build(cfg, { forceFull: true })

        assert.equal(cfg.sources[0].title, 'Site')
        assert.equal(cfg.sources[1].title, 'mkadoc')

        assert.ok(fs.existsSync(path.join(root, 'site/docs/index.html')))
        assert.ok(fs.existsSync(path.join(root, 'site/apps/mkadoc/docs/index.html')))
        assert.ok(fs.existsSync(path.join(root, 'site/apps/mkadoc/docs/guide.html')))

        const header = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.ok(header.querySelector('#mkadoc-topbar'))
        assert.ok(header.querySelector('#mkadoc-articles'))
        assert.deepEqual(
          header.querySelectorAll('a.mkadoc-source').map((el) => ({
            mount: el.getAttribute('data-mount'),
            text: el.text.trim(),
          })),
          [
            { mount: '/docs', text: 'Site' },
            { mount: '/apps/mkadoc/docs', text: 'mkadoc' },
          ],
        )

        const outRel = pageToOutRel(cfg.sources[1], 'apps/mkadoc/docs/guide.adoc')
        assert.equal(outRel, 'apps/mkadoc/docs/guide.html')
        assert.equal(
          sourceForPathname(cfg.sources, '/apps/mkadoc/docs/guide.html')?.path,
          'apps/mkadoc/docs',
        )
      },
    )
  })

  it('auto-nav when _nav.adoc is missing', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:topbar: {}
  mkadoc:nav: {}
`),
        'docs/index.adoc': '= Site\n\nHi.\n',
        'docs/other.adoc': '= Other\n\nThere.\n',
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const header = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        const hrefs = header
          .querySelectorAll('#mkadoc-articles a')
          .map((el) => el.getAttribute('href'))
        assert.ok(hrefs.includes('/docs/index.html'))
        assert.ok(hrefs.includes('/docs/other.html'))
      },
    )
  })

  it('uses site.brand as the topbar brand', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
site:
  brand: Nix-managed system
plugins:
  mkadoc:topbar: {}
`),
        'docs/index.adoc': `= Dotfiles

Body.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const header = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        const brand = header.querySelector('.mkadoc-brand')
        assert.ok(brand)
        assert.equal(brand.getAttribute('data-site-title'), 'Nix-managed system')
        assert.equal(brand.querySelector('p')?.text.trim(), 'Nix-managed system')
      },
    )
  })

  it('index.adoc :nav_label: change refreshes source-bar chrome', async () => {
    await withTempProject(
      {
        'mkadoc.yaml': yamlConfig(`sources:
  - docs
  - apps/mkadoc/docs
output: site
plugins:
  mkadoc:topbar: {}
  mkadoc:nav: {}
`),
        'docs/index.adoc': `= Dotfiles
:nav_label: Site

Root.
`,
        'apps/mkadoc/docs/index.adoc': `= mkadoc

App.
`,
      },
      async (root) => {
        const cfg = await loadConfig('mkadoc.yaml', root)
        await build(cfg, { forceFull: true })
        const headerBefore = parseHtml(
          fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'),
        )
        assert.ok(
          headerBefore
            .querySelectorAll('a.mkadoc-source')
            .some((el) => el.text.trim() === 'mkadoc'),
        )

        fs.writeFileSync(
          path.join(root, 'apps/mkadoc/docs/index.adoc'),
          `= mkadoc
:nav_label: Mkadocx

App.
`,
        )

        const mode = await build(cfg, { paths: ['apps/mkadoc/docs/index.adoc'] })
        assert.equal(mode, 'incremental')
        assert.equal(cfg.sources[1].title, 'Mkadocx')

        const headerAfter = parseHtml(
          fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'),
        )
        assert.ok(
          headerAfter
            .querySelectorAll('a.mkadoc-source')
            .some((el) => el.text.trim() === 'Mkadocx'),
        )

        const appPage = parseHtml(
          fs.readFileSync(path.join(root, 'site/apps/mkadoc/docs/index.html'), 'utf8'),
        )
        const docsPage = parseHtml(fs.readFileSync(path.join(root, 'site/docs/index.html'), 'utf8'))
        assert.ok(
          appPage.querySelectorAll('a.mkadoc-source').some((el) => el.text.trim() === 'Mkadocx'),
        )
        assert.ok(
          docsPage.querySelectorAll('a.mkadoc-source').some((el) => el.text.trim() === 'Mkadocx'),
        )
        // Page <title> still follows doctitle / :title:, not :nav_label:
        assert.equal(appPage.querySelector('title')?.text.trim(), 'mkadoc')
      },
    )
  })
})
