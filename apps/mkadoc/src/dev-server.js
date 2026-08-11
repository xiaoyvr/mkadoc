import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import handler from 'serve-handler'

const RELOAD_SCRIPT = `<script>(function(){try{var es=new EventSource("/__mkadoc/events");es.onmessage=function(){location.reload()};}catch(e){}})();</script>`

/**
 * @param {string} root
 * @param {string} pathname
 * @returns {string | null}
 */
function resolveHtmlFile(root, pathname) {
  let rel = decodeURIComponent((pathname || '/').split('?')[0])
  if (!rel.startsWith('/')) rel = `/${rel}`
  if (rel.endsWith('/')) rel += 'index.html'
  else if (!path.posix.basename(rel).includes('.')) rel += '/index.html'
  if (!rel.endsWith('.html')) return null

  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel.slice(1))
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
  if (abs !== rootAbs && !abs.startsWith(prefix)) return null
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return abs
}

/**
 * @param {string} url
 */
function openBrowser(url) {
  const platform = process.platform
  if (platform === 'darwin') {
    execFile('open', [url], () => {})
  } else if (platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {})
  } else {
    execFile('xdg-open', [url], () => {})
  }
}

/**
 * Static file server for `site/` with SSE-based live reload.
 *
 * @param {{
 *   root: string,
 *   host: string,
 *   port: number,
 *   open?: boolean,
 * }} opts
 * @returns {Promise<{ close: () => Promise<void>, reload: () => void, url: string }>}
 */
export async function createDevServer(opts) {
  const { root, host, port, open = false } = opts
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (url.pathname === '/__mkadoc/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const htmlFile = resolveHtmlFile(root, url.pathname)
      if (htmlFile) {
        const body = fs.readFileSync(htmlFile, 'utf8')
        const injected = body.includes('</body>')
          ? body.replace('</body>', `${RELOAD_SCRIPT}</body>`)
          : body + RELOAD_SCRIPT
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : injected)
        return
      }
    }

    try {
      await handler(req, res, {
        public: root,
        cleanUrls: false,
        directoryListing: false,
      })
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(err?.message || 'Internal Server Error')
      }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  const url = `http://127.0.0.1:${boundPort}/`
  if (open) openBrowser(url)

  function reload() {
    for (const client of clients) {
      try {
        client.write('data: reload\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }

  async function close() {
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    clients.clear()
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return { close, reload, url }
}
