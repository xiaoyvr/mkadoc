import { z } from 'zod'
import { userError } from './errors.js'
import { BUILTIN_LOCATORS } from './plugin/locators.js'

/**
 * Parsed project config (Zod output), before runtime fields are attached.
 *
 * @typedef {object} ProjectConfig
 * @property {string} source
 * @property {string} output
 * @property {string} cache
 * @property {{ from: string, to: string }[]} assets
 * @property {Record<string, Record<string, unknown>>} plugins
 * @property {{ remote: boolean, port: number }} serve
 */

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

/**
 * Plugin option values are opaque here — each plugin validates/defaults its own
 * options at load time. Core only allowlists builtin locators.
 */
const PluginsSchema = z.preprocess(
  (v) => (v == null ? {} : v),
  z.record(z.string(), z.record(z.string(), z.unknown())).superRefine((plugins, ctx) => {
    for (const key of Object.keys(plugins)) {
      if (!BUILTIN_LOCATORS.includes(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown plugin "${key}"`,
          path: [key],
        })
      }
    }
  }),
)

/**
 * Project config mapping (before runtime fields like `root` are attached).
 * Unknown top-level / `serve.*` keys are rejected (`.strict()`).
 * Unknown plugin *locators* are rejected; plugin option fields are not.
 */
export const ConfigSchema = z
  .object({
    source: z.string().min(1).default('docs'),
    output: z.string().min(1).default('site'),
    cache: z.string().min(1).default('.cache/asciidoctor'),
    assets: z.array(AssetSchema).default([]),
    plugins: PluginsSchema,
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
 * @returns {ProjectConfig}
 */
export function parseProjectConfig(raw) {
  const result = ConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    throw userError(`mkadoc: invalid config: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
