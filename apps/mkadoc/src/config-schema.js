import { z } from 'zod'

const portSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  return Number(value)
}, z.number().int().min(1).max(65535).default(8000))

const ServeSchema = z
  .object({
    remote: z.boolean().default(false),
    port: portSchema,
  })
  .strict()

const AssetSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict()

const NavPluginSchema = z
  .object({
    nav: z.string().optional(),
    css_href: z.string().optional(),
    js_href: z.string().optional(),
  })
  .strict()

const ShikiPluginSchema = z
  .object({
    theme: z.string().optional(),
    langs: z.array(z.string()).optional(),
    css_href: z.string().optional(),
  })
  .strict()

const KrokiPluginSchema = z
  .object({
    server_url: z.string().optional(),
    data_uri: z.boolean().optional(),
    allow_uri_read: z.boolean().optional(),
    cache_dir: z.string().optional(),
  })
  .strict()

/** Only built-in locators; unknown plugin keys fail validation. */
const PluginsSchema = z
  .object({
    'mkadoc:nav': NavPluginSchema.optional(),
    'mkadoc:shiki': ShikiPluginSchema.optional(),
    'mkadoc:kroki-diagram': KrokiPluginSchema.optional(),
  })
  .strict()

/**
 * Project config mapping (before runtime fields like `root` are attached).
 * Unknown top-level / `serve.*` / plugin keys are rejected (`.strict()`).
 */
export const ConfigSchema = z
  .object({
    source: z.string().min(1).default('docs'),
    output: z.string().min(1).default('site'),
    cache: z.string().min(1).default('.cache/asciidoctor'),
    assets: z.array(AssetSchema).default([]),
    plugins: z.preprocess((v) => (v == null ? {} : v), PluginsSchema),
    serve: z.preprocess((v) => (v == null ? {} : v), ServeSchema),
  })
  .strict()

/**
 * @param {import('zod').ZodError} err
 */
export function formatConfigZodError(err) {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Validate and apply defaults to a raw config mapping.
 * @param {unknown} raw
 */
export function parseProjectConfig(raw) {
  const result = ConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    throw new Error(`mkadoc: invalid config: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
