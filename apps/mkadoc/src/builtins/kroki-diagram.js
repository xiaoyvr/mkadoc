import path from 'node:path'
import asciidoctorKroki from 'asciidoctor-kroki'
import { resolvePluginOptions } from '../plugin/options.js'

const DEFAULTS = {
  server_url: 'http://127.0.0.1:8080',
  data_uri: true,
  allow_uri_read: true,
  cache_dir: 'diagram',
}

/**
 * @param {Record<string, unknown>} [rawOptions]
 * @returns {import('../plugin/contract.js').MkadocPlugin}
 */
export default function krokiDiagramPlugin(rawOptions = {}) {
  const options = resolvePluginOptions('mkadoc:kroki-diagram', rawOptions, DEFAULTS)
  const serverUrl = process.env.KROKI_SERVER_URL || options.server_url
  const dataUri = options.data_uri
  const allowUriRead = options.allow_uri_read
  const cacheName = options.cache_dir

  let diagramDir = ''

  return {
    name: 'kroki-diagram',

    async setup(host) {
      diagramDir = host.cacheDir(cacheName)
      host.registerExtension((registry) => {
        asciidoctorKroki.register(registry)
      })
      host.addAttributes({
        'kroki-server-url': serverUrl,
        'data-uri': dataUri,
        'allow-uri-read': allowUriRead,
        imagesoutdir: diagramDir || path.join(host.root, host.config.cache, cacheName),
      })
    },

    async check() {
      const url = `${serverUrl.replace(/\/$/, '')}/`
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) {
          return {
            ok: false,
            message: `Kroki HTTP ${res.status} at ${url}`,
          }
        }
        return { ok: true, message: `Kroki ok (${url})` }
      } catch (err) {
        return {
          ok: false,
          message: `Kroki unreachable at ${url}: ${err.message}`,
        }
      }
    },
  }
}
