import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createTestHost } from '../src/index.js'

describe('createTestHost', () => {
  it('serves registered modules via import', async () => {
    const zod = { z: Symbol('z') }
    const host = createTestHost({ imports: { zod } })
    assert.equal(await host.import('zod'), zod)
  })

  it('rejects unregistered modules', async () => {
    const host = createTestHost()
    await assert.rejects(() => host.import('nope'), /no module registered/)
  })

  it('records hook calls into _test', () => {
    const host = createTestHost()
    host.addAttributes({ icons: 'font' })
    host.registerSiteWideDep('docs/_nav.adoc')
    host.registerAssetPrefix('site/styles/')
    host.contributeChromeBody('<aside>hi</aside>')
    host.contributeHead({ links: [{ rel: 'stylesheet', href: '/x.css' }] })

    assert.deepEqual(host._test.attributes, { icons: 'font' })
    assert.deepEqual(host._test.siteWideDeps, ['docs/_nav.adoc'])
    assert.deepEqual(host._test.assetPrefixes, ['site/styles/'])
    assert.deepEqual(host._test.chromeBody, ['<aside>hi</aside>'])
    assert.equal(host._test.headLinks.length, 1)
  })

  it('ensureDir / cacheDir create directories under root', () => {
    const root = '/tmp/mkadoc-test-host'
    const host = createTestHost({ root })
    const abs = host.cacheDir('diagram')
    assert.equal(abs, path.join(root, '.mkadoc', 'diagram'))
  })
})
