import { userError } from '../errors.js'

/**
 * Merge plugin options with defaults; reject unknown keys (plugin-owned validation).
 *
 * @template {Record<string, unknown>} T
 * @param {string} locator
 * @param {unknown} raw
 * @param {T} defaults
 * @returns {T}
 */
export function resolvePluginOptions(locator, raw, defaults) {
  const opts = raw == null ? {} : raw
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw userError(`mkadoc: ${locator}: options must be a mapping`)
  }
  const unknown = Object.keys(opts).filter((key) => !Object.hasOwn(defaults, key))
  if (unknown.length) {
    throw userError(
      `mkadoc: ${locator}: unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    )
  }
  return { ...defaults, ...opts }
}
