import { formatConfigZodError } from '../config-schema.js'

export function parsePluginOptions(locator, schema, raw) {
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    throw new Error(`mkadoc: ${locator}: ${formatConfigZodError(result.error)}`)
  }
  return result.data
}
