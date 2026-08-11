import { formatConfigZodError } from '../config-schema.js'
import { userError } from '../errors.js'

/**
 * Validate plugin options with a Zod schema (defaults + strict unknown keys).
 *
 * @template {import('zod').ZodType} S
 * @param {string} locator
 * @param {S} schema
 * @param {unknown} raw
 * @returns {import('zod').infer<S>}
 */
export function parsePluginOptions(locator, schema, raw) {
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    throw userError(`mkadoc: ${locator}: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
