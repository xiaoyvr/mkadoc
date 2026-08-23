import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { build } from '../src/build.js'
import { loadConfig } from '../src/config.js'
import { decideMode } from '../src/decide-mode.js'
import {
  DependencyGraph,
  includeResolveDir,
  loadDependencyGraph,
  registerIncludeCollector,
  withIncludeCollector,
} from '../src/deps.js'
import { createHosts } from '../src/plugin/host.js'
import { loadPlugins } from '../src/plugin/load.js'
import { literateConfig, smokeFixture, withTempProject } from './helpers/project.js'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function mtimeMs(root, rel) {
  return fs.statSync(path.join(root, rel)).mtimeMs
}

describe('DependencyGraph', () => {
  it('records forward edges and reverse pagesDependingOn', async () => {
    await withTempProject({}, async (root) => {
      const g = new DependencyGraph(root)
      g.setPageIncludes('docs/guide.adoc', ['docs/_a.adoc', 'docs/parts/_b.adoc'])
      g.setPageIncludes('docs/index.adoc', ['docs/_a.adoc'])
      assert.deepEqual(g.pagesDependingOn('docs/_a.adoc'), ['docs/guide.adoc', 'docs/index.adoc'])
      assert.deepEqual(g.pagesDependingOn('docs/parts/_b.adoc'), ['docs/guide.adoc'])
      assert.deepEqual(g.pagesDependingOn('docs/_missing.adoc'), [])
    })
  })

  it('site-wide deps return every live page', async () => {
    await withTempProject({}, async (root) => {
      const g = new DependencyGraph(root)
      g.addSiteWide('docs/index.adoc')
      g.setPageIncludes('docs/guide.adoc', [])
      assert.deepEqual(
        g.pagesDependingOn('docs/index.adoc', {
          livePages: ['docs/guide.adoc', 'docs/index.adoc'],
        }),
        ['docs/guide.adoc', 'docs/index.adoc'],
      )
      assert.equal(g.isSiteWide('docs/index.adoc'), true)
    })
  })

  it('persists and reloads from .mkadoc/deps.json', async () => {
    await withTempProject({}, async (root) => {
      const g = new DependencyGraph(root)
      g.setPageIncludes('docs/guide.adoc', ['docs/_p.adoc'])
      g.addSiteWide('docs/index.adoc')
      g.save()
      assert.ok(fs.existsSync(path.join(root, '.mkadoc/deps.json')))

      const loaded = loadDependencyGraph(root)
      assert.deepEqual(loaded.pagesDependingOn('docs/_p.adoc'), ['docs/guide.adoc'])
      // Site-wide is ephemeral — not persisted.
      assert.equal(loaded.isSiteWide('docs/index.adoc'), false)
    })
  })

  it('retainPages drops deleted pages', async () => {
    await withTempProject({}, async (root) => {
      const g = new DependencyGraph(root)
      g.setPageIncludes('docs/guide.adoc', ['docs/_p.adoc'])
      g.setPageIncludes('docs/gone.adoc', ['docs/_p.adoc'])
      g.retainPages(['docs/guide.adoc'])
      assert.deepEqual(g.pagesDependingOn('docs/_p.adoc'), ['docs/guide.adoc'])
      assert.equal(g.pages.has('docs/gone.adoc'), false)
    })
  })
})

describe('includeResolveDir', () => {
  it('uses absolute reader.path dirname for nested includes', () => {
    assert.equal(
      includeResolveDir({ path: '/repo/docs/parts/_p.adoc', _dir: 'parts' }, '/repo/docs'),
      '/repo/docs/parts',
    )
  })

  it('falls back to absolute _dir or baseDir for top-level stdin', () => {
    assert.equal(
      includeResolveDir({ path: '<stdin>', _dir: '/repo/docs' }, '/repo/docs'),
      '/repo/docs',
    )
    assert.equal(includeResolveDir({ path: '<stdin>' }, '/repo/docs'), '/repo/docs')
  })
})

describe('include collector', () => {
  it('records nested includes relative to the including file', async () => {
    await withTempProject(
      {
        'docs/page.adoc': '= Page\n\ninclude::parts/_p.adoc[]\n',
        'docs/parts/_p.adoc': 'partial\n\ninclude::_sib.adoc[]\n',
        'docs/parts/_sib.adoc': 'sibling\n',
      },
      async (root) => {
        const { Extensions, load } = await import('@asciidoctor/core')
        const registry = Extensions.create()
        registerIncludeCollector(registry)
        const baseDir = path.join(root, 'docs')
        const text = fs.readFileSync(path.join(root, 'docs/page.adoc'), 'utf8')
        const { result: html, includes } = await withIncludeCollector(
          { root, baseDir },
          async () => {
            const doc = await load(text, {
              safe: 'unsafe',
              base_dir: baseDir,
              standalone: true,
              extension_registry: registry,
            })
            return String(await doc.convert())
          },
        )
        assert.match(html, /sibling/)
        assert.deepEqual(includes, ['docs/parts/_p.adoc', 'docs/parts/_sib.adoc'])
      },
    )
  })
})

describe('decideMode + dependency graph', () => {
  it('expands an included partial to dependent pages (incremental)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      deps.setPageIncludes('docs/guide.adoc', ['docs/_partial.adoc'])
      deps.setPageIncludes('docs/index.adoc', [])
      const { build: host } = createHosts(cfg, { deps })

      const decided = decideMode(cfg, host, {
        paths: ['docs/_partial.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'incremental')
      assert.deepEqual(decided.pages, ['docs/guide.adoc'])
    })
  })

  it('treats unused partial as noop when nothing depends on it', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      deps.setPageIncludes('docs/guide.adoc', [])
      deps.setPageIncludes('docs/index.adoc', [])
      const { build: host } = createHosts(cfg, { deps })

      const decided = decideMode(cfg, host, {
        paths: ['docs/_partial.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'noop')
      assert.deepEqual(decided.pages, [])
    })
  })

  it('treats a partial as noop when the graph is empty (no known dependents)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      const { build: host } = createHosts(cfg, { deps })

      const decided = decideMode(cfg, host, {
        paths: ['docs/_partial.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'noop')
      assert.deepEqual(decided.pages, [])
    })
  })

  it('treats _chrome.adoc as assets (CSS only)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      deps.setPageIncludes('docs/index.adoc', [])
      const { build: host } = createHosts(cfg, { deps })

      const decided = decideMode(cfg, host, {
        paths: ['docs/_chrome.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'assets')
      assert.deepEqual(decided.pages, [])
    })
  })

  it('expands index.adoc as site-wide to all live pages (via mkadoc:nav)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      const { plugin, build: host } = createHosts(cfg, { deps })
      await loadPlugins({ 'mkadoc:nav': {} }, plugin)
      deps.setPageIncludes('docs/guide.adoc', [])
      deps.setPageIncludes('docs/index.adoc', [])

      const decided = decideMode(cfg, host, {
        paths: ['docs/index.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'incremental')
      assert.deepEqual(decided.pages, ['docs/guide.adoc', 'docs/index.adoc'])
    })
  })

  it('expands logo override as site-wide to all live pages (via mkadoc:topbar)', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      const { plugin, build: host } = createHosts(cfg, { deps })
      await loadPlugins({ 'mkadoc:topbar': {} }, plugin)
      deps.setPageIncludes('docs/guide.adoc', [])
      deps.setPageIncludes('docs/index.adoc', [])

      const decided = decideMode(cfg, host, {
        paths: ['docs/_assets/logo.svg'],
        deps,
      })
      assert.equal(decided.mode, 'incremental')
      assert.deepEqual(decided.pages, ['docs/guide.adoc', 'docs/index.adoc'])
    })
  })

  it('expands _nav.adoc as site-wide via registerSiteWideDep', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_nav.adoc': '* xref:index.adoc[Home]\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        const deps = new DependencyGraph(root)
        deps.setPageIncludes('docs/guide.adoc', [])
        deps.setPageIncludes('docs/index.adoc', [])
        const { plugin, build: host } = createHosts(cfg, { deps })
        const { loadPlugins } = await import('../src/plugin/load.js')
        await loadPlugins(cfg.plugins, plugin)

        assert.equal(deps.isSiteWide('docs/_nav.adoc'), true)

        const decided = decideMode(cfg, host, {
          paths: ['docs/_nav.adoc'],
          deps,
        })
        assert.equal(decided.mode, 'incremental')
        assert.deepEqual(decided.pages, ['docs/guide.adoc', 'docs/index.adoc'])
      },
    )
  })

  it('still forces full for config path', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      const deps = new DependencyGraph(root)
      const { build: host } = createHosts(cfg, { deps })

      const decided = decideMode(cfg, host, {
        paths: ['mkadoc.adoc'],
        deps,
      })
      assert.equal(decided.mode, 'full')
    })
  })
})

describe('build include dependencies', () => {
  it('full build writes deps cache with include edges', async () => {
    await withTempProject(
      smokeFixture({
        'docs/guide.adoc': `= Smoke Guide

include::_shared.adoc[]
`,
        'docs/_shared.adoc': 'SHARED_V1\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        assert.match(read(root, 'site/docs/guide.html'), /SHARED_V1/)
        const deps = loadDependencyGraph(root)
        assert.deepEqual(deps.pages.get('docs/guide.adoc'), ['docs/_shared.adoc'])
        assert.deepEqual(deps.pagesDependingOn('docs/_shared.adoc'), ['docs/guide.adoc'])
      },
    )
  })

  it('included partial edit rebuilds only dependent pages', async () => {
    await withTempProject(
      smokeFixture({
        'docs/guide.adoc': `= Smoke Guide

include::_shared.adoc[]
`,
        'docs/other.adoc': `= Other

OTHER_V1
`,
        'docs/_shared.adoc': 'SHARED_V1\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        const indexBefore = read(root, 'site/docs/index.html')
        const otherBefore = read(root, 'site/docs/other.html')
        const indexMtime = mtimeMs(root, 'site/docs/index.html')
        const otherMtime = mtimeMs(root, 'site/docs/other.html')

        fs.writeFileSync(path.join(root, 'docs/_shared.adoc'), 'SHARED_V2\n')
        await new Promise((r) => setTimeout(r, 20))

        const mode = await build(cfg, { paths: ['docs/_shared.adoc'] })
        assert.equal(mode, 'incremental')
        assert.match(read(root, 'site/docs/guide.html'), /SHARED_V2/)
        assert.equal(read(root, 'site/docs/index.html'), indexBefore)
        assert.equal(read(root, 'site/docs/other.html'), otherBefore)
        assert.equal(mtimeMs(root, 'site/docs/index.html'), indexMtime)
        assert.equal(mtimeMs(root, 'site/docs/other.html'), otherMtime)
      },
    )
  })

  it('nested include edit rebuilds the page that pulls it in', async () => {
    await withTempProject(
      smokeFixture({
        'docs/guide.adoc': `= Smoke Guide

include::parts/_p.adoc[]
`,
        'docs/parts/_p.adoc': 'P_V1\n\ninclude::_sib.adoc[]\n',
        'docs/parts/_sib.adoc': 'SIB_V1\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })
        assert.match(read(root, 'site/docs/guide.html'), /SIB_V1/)

        const deps = loadDependencyGraph(root)
        assert.deepEqual(deps.pages.get('docs/guide.adoc'), [
          'docs/parts/_p.adoc',
          'docs/parts/_sib.adoc',
        ])

        fs.writeFileSync(path.join(root, 'docs/parts/_sib.adoc'), 'SIB_V2\n')
        const mode = await build(cfg, { paths: ['docs/parts/_sib.adoc'] })
        assert.equal(mode, 'incremental')
        assert.match(read(root, 'site/docs/guide.html'), /SIB_V2/)
      },
    )
  })

  it('unused underscore partial is a noop', async () => {
    await withTempProject(smokeFixture(), async (root) => {
      const cfg = await loadConfig('mkadoc.adoc', root)
      await build(cfg, { forceFull: true })

      const indexBefore = read(root, 'site/docs/index.html')
      const guideBefore = read(root, 'site/docs/guide.html')

      fs.writeFileSync(path.join(root, 'docs/_partial.adoc'), '= Partial\n\nUpdated unused.\n')
      const mode = await build(cfg, { paths: ['docs/_partial.adoc'] })
      assert.equal(mode, 'noop')
      assert.equal(read(root, 'site/docs/index.html'), indexBefore)
      assert.equal(read(root, 'site/docs/guide.html'), guideBefore)
    })
  })

  it('_chrome.adoc edit rewrites topbar CSS in assets mode without reconverting pages', async () => {
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
        assert.match(read(root, 'site/styles/topbar.css'), /height: 2rem/)

        const indexBefore = read(root, 'site/docs/index.html')
        fs.writeFileSync(
          path.join(root, 'docs/_chrome.adoc'),
          `
[mkadoc-css]
----
.mkadoc-topbar { height: 4rem; }
----
`,
        )
        const mode = await build(cfg, { paths: ['docs/_chrome.adoc'] })
        assert.equal(mode, 'assets')
        assert.match(read(root, 'site/styles/topbar.css'), /height: 4rem/)
        assert.equal(read(root, 'site/docs/index.html'), indexBefore)
      },
    )
  })

  it('_nav.adoc edit rebuilds all pages incrementally', async () => {
    await withTempProject(
      smokeFixture({
        'mkadoc.adoc': literateConfig(`sources:
  - docs
output: site
plugins:
  mkadoc:nav: {}
`),
        'docs/_nav.adoc': '* xref:index.adoc[Home]\n',
      }),
      async (root) => {
        const cfg = await loadConfig('mkadoc.adoc', root)
        await build(cfg, { forceFull: true })

        fs.writeFileSync(
          path.join(root, 'docs/_nav.adoc'),
          '* xref:index.adoc[Home]\n* xref:guide.adoc[Guide]\n',
        )
        const mode = await build(cfg, { paths: ['docs/_nav.adoc'] })
        assert.equal(mode, 'incremental')
        assert.match(read(root, 'site/docs/index.html'), /Guide/)
        assert.match(read(root, 'site/docs/guide.html'), /Guide/)
      },
    )
  })
})
