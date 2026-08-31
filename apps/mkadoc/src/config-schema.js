import npa from 'npm-package-arg'
import { z } from 'zod'
import { BUILTIN_LOCATORS } from './plugin/locators.js'

const portSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  return Number(value)
}, z.number().int().min(1).max(65535).default(8000))

export const ServeSchema = z
  .object({
    remote: z.boolean().default(false),
    port: portSchema,
  })
  .strict()

const SiteSchema = z
  .object({
    brand: z.string().min(1),
  })
  .strict()

const PluginsSchema = z.preprocess(
  (v) => (v == null ? {} : v),
  z.record(z.string(), z.record(z.string(), z.unknown())).superRefine((plugins, ctx) => {
    for (const key of Object.keys(plugins)) {
      if (key.startsWith('mkadoc:')) {
        if (!BUILTIN_LOCATORS.includes(key)) {
          ctx.addIssue({
            code: 'custom',
            message: `Unknown builtin plugin "${key}"`,
            path: [key],
          })
        }
        continue
      }
      let spec
      try {
        spec = npa(key)
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid plugin locator "${key}": ${err?.message || err}`,
          path: [key],
        })
        continue
      }
      // Registry ranges, git/github, remote tarballs parse fine (npa grammar)
      // but the loader does not implement them — reject early for a better
      // error than the load-time "not supported yet".
      if (spec.type !== 'file' && spec.type !== 'directory') {
        ctx.addIssue({
          code: 'custom',
          message: `Plugin locator "${key}" (${spec.type}) is not supported yet — use a local folder plugin ("file:./path/to/plugin" or "./path")`,
          path: [key],
        })
      }
    }
  }),
)

const ConfigSchema = z
  .object({
    sources: z.array(z.string().min(1)).min(1),
    output: z.string().min(1).default('site'),
    site: SiteSchema,
    plugins: PluginsSchema,
    serve: z.preprocess((v) => (v == null ? {} : v), ServeSchema),
  })
  .strict()

export function formatConfigZodError(err) {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export function parseProjectConfig(raw) {
  const result = ConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    throw new Error(`mkadoc: invalid config: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}

/** Validate/normalize `serve` (config defaults or CLI overrides). */
export function parseServeConfig(raw) {
  const result = ServeSchema.safeParse(raw ?? {})
  if (!result.success) {
    throw new Error(`mkadoc: invalid serve: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
