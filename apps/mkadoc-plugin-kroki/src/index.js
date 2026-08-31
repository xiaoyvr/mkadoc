import asciidoctorKroki from 'asciidoctor-kroki'

/**
 * Parse + validate plugin options with the zod instance provided by the host.
 * External plugins must not import zod themselves — shared deps come from the
 * core whitelist via `host.import` (factory-time need: options parse before
 * dependency resolution) or `host.plugin(['zod'], ...)` inside the body.
 *
 * @param {import('zod').ZodType} schema
 * @param {unknown} raw
 * @returns {unknown}
 */
function parseOptions(schema, raw) {
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const p = issue.path.length ? issue.path.join('.') : '(root)'
        return `${p}: ${issue.message}`
      })
      .join('; ')
    throw new Error(`mkadoc-plugin-kroki: ${detail}`)
  }
  return result.data
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default async function krokiDiagramPlugin(rawOptions = {}, host) {
  const { z } = await host.import('zod')

  const OptionsSchema = z
    .object({
      server_url: z.string().min(1),
      allow_uri_read: z.boolean().default(true),
      cache_dir: z.string().min(1).default('diagram'),
    })
    .strict()

  const {
    server_url: serverUrl,
    allow_uri_read: allowUriRead,
    cache_dir: cacheName,
  } = parseOptions(OptionsSchema, rawOptions)

  // Provide a renderer-agnostic `diagram` capability. The Asciidoctor
  // renderer consumes `register` + `attributes`; future renderers can add
  // other adapters (e.g. a generic `render(source, type)`). The provider
  // factory runs at dependency resolution — lazily, only when a consumer
  // depends on `diagram`.
  host.provide('diagram', () => ({
    register(registry) {
      asciidoctorKroki.register(registry)
    },
    attributes: {
      'kroki-server-url': serverUrl,
      'kroki-fetch-diagram': '',
      // Scope data-URI embedding to kroki diagrams only (kroki-data-uri),
      // leaving regular images as file references that get copied.
      'kroki-data-uri': '',
      'allow-uri-read': allowUriRead,
      imagesoutdir: host.cacheDir(cacheName),
    },
  }))

  return host.plugin([], () => ({
    name: 'kroki-diagram',

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
  }))
}
