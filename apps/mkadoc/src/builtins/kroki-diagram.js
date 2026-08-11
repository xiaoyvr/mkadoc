import path from 'node:path'
import asciidoctorKroki from 'asciidoctor-kroki'
import { z } from 'zod'
import { parsePluginOptions } from '../plugin/options.js'

const OptionsSchema = z
  .object({
    server_url: z.string().min(1),
    data_uri: z.boolean().default(true),
    allow_uri_read: z.boolean().default(true),
    cache_dir: z.string().min(1).default('diagram'),
  })
  .strict()

/**
 * @param {Record<string, unknown>} [rawOptions]
 * @returns {import('../plugin/contract.js').MkadocPlugin}
 */
export default function krokiDiagramPlugin(rawOptions = {}) {
  const {
    server_url: serverUrl,
    data_uri: dataUri,
    allow_uri_read: allowUriRead,
    cache_dir: cacheName,
  } = parsePluginOptions('mkadoc:kroki-diagram', OptionsSchema, rawOptions)

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
