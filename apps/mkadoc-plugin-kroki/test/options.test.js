import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createTestHost } from '@mkadoc/plugin-host'
import { z } from 'zod'
import krokiPlugin from '../src/index.js'

const host = createTestHost({ imports: { zod: { z } } })

describe('mkadoc-plugin-kroki', () => {
  it('factory requires server_url', async () => {
    await assert.rejects(() => krokiPlugin({}, host), /server_url/)
    await assert.rejects(() => krokiPlugin({ server_url: '' }, host), /server_url/)
  })

  it('factory rejects unknown options', async () => {
    await assert.rejects(
      () => krokiPlugin({ server_url: 'http://127.0.0.1:8080', nope: true }, host),
      /Unrecognized key: "nope"/,
    )
  })

  it('setup registers the kroki extension and attributes', async () => {
    const plugin = await krokiPlugin({ server_url: 'http://127.0.0.1:8080' }, host)
    assert.equal(plugin.name, 'kroki-diagram')
    await plugin.setup(host)

    assert.equal(host._test.extensions.length, 1)
    assert.equal(host._test.attributes['kroki-server-url'], 'http://127.0.0.1:8080')
    assert.equal(host._test.attributes['kroki-fetch-diagram'], '')
    assert.ok(host._test.attributes.imagesoutdir.endsWith(path.join('.mkadoc', 'diagram')))
  })

  it('check reports unreachable server as failure', async () => {
    const plugin = await krokiPlugin({ server_url: 'http://127.0.0.1:9' }, host)
    const result = await plugin.check(host)
    assert.equal(result.ok, false)
    assert.match(result.message, /Kroki unreachable/)
  })
})
