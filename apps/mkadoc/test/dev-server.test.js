import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createDevServer } from '../src/dev-server.js'
import { withTempProject } from './helpers/project.js'

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      .on('error', reject)
  })
}

describe('dev-server', () => {
  it('serves pages, assets, and reload() notifies SSE clients', async () => {
    await withTempProject(
      {
        'site/index.html': `<!doctype html><html><body><p>HELLO</p></body></html>\n`,
        'site/styles/app.css': `body{color:red}\n`,
      },
      async (root) => {
        const server = await createDevServer({
          root: path.join(root, 'site'),
          host: '127.0.0.1',
          port: 0,
          open: false,
        })

        try {
          const page = await get(server.url)
          assert.equal(page.status, 200)
          assert.match(page.body, /HELLO/)
          assert.match(page.body, /__mkadoc\/events/)
          assert.match(page.body, /pagehide/)
          assert.match(page.body, /beforeunload/)
          assert.match(page.body, /es\.close/)

          const css = await get(new URL('styles/app.css', server.url).href)
          assert.equal(css.status, 200)
          assert.match(css.body, /color:red/)

          const reloadPromise = new Promise((resolve, reject) => {
            const req = http.get(new URL('__mkadoc/events', server.url), (res) => {
              assert.equal(res.statusCode, 200)
              res.on('data', (chunk) => {
                if (String(chunk).includes('data: reload')) {
                  res.destroy()
                  resolve(true)
                }
              })
            })
            req.on('error', reject)
            setTimeout(() => reject(new Error('SSE reload timed out')), 2000)
          })

          await new Promise((r) => setTimeout(r, 50))
          server.reload()
          assert.equal(await reloadPromise, true)
        } finally {
          await server.close()
        }
      },
    )
  })

  it('redirects / to rootRedirect when configured', async () => {
    await withTempProject(
      {
        'site/docs/index.html': `<!doctype html><html><body><p>DOCS</p></body></html>\n`,
      },
      async (root) => {
        const server = await createDevServer({
          root: path.join(root, 'site'),
          host: '127.0.0.1',
          port: 0,
          open: false,
          rootRedirect: '/docs/index.html',
        })

        try {
          const res = await new Promise((resolve, reject) => {
            http.get(server.url, (r) => {
              r.resume()
              r.on('end', () => resolve(r))
            }).on('error', reject)
          })
          assert.equal(res.statusCode, 302)
          assert.equal(res.headers.location, '/docs/index.html')
        } finally {
          await server.close()
        }
      },
    )
  })

  it('close() terminates even with an open SSE connection', async () => {
    await withTempProject(
      {
        'site/index.html': `<!doctype html><html><body><p>HELLO</p></body></html>\n`,
      },
      async (root) => {
        const server = await createDevServer({
          root: path.join(root, 'site'),
          host: '127.0.0.1',
          port: 0,
          open: false,
        })

        // Open an SSE connection and keep it open (the browser-tab case that
        // previously hung `server.close()` forever).
        const resClosed = new Promise((resolve) => {
          const req = http.get(new URL('__mkadoc/events', server.url), (res) => {
            res.on('data', () => {})
            res.once('close', () => resolve('res-close'))
            res.once('aborted', () => resolve('res-aborted'))
            res.once('error', () => resolve('res-error'))
          })
          req.once('error', () => resolve('req-error'))
        })
        // Wait for the SSE response to be established before closing.
        await new Promise((r) => setTimeout(r, 100))

        try {
          const closed = await Promise.race([
            server.close().then(() => 'closed'),
            new Promise((r) => setTimeout(() => r('timeout'), 2000)),
          ])
          assert.equal(closed, 'closed')
          const signal = await Promise.race([
            resClosed,
            new Promise((r) => setTimeout(() => r('timeout'), 2000)),
          ])
          assert.notEqual(signal, 'timeout', 'open connection should be force-closed')
        } finally {
          await server.close().catch(() => {})
        }
      },
    )
  })
})
