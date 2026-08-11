import { formatConfigZodError } from '../config-schema.js'
import { userError } from '../errors.js'

export function parsePluginOptions(locator, schema, raw) {
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    throw userError(`mkadoc: ${locator}: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
