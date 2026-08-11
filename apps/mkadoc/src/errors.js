/**
 * Expected/user-facing mkadoc failure (bad config, bad args, convert errors, …).
 * CLI prints `message` only — no stack — for these.
 */
export class MkadocError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'MkadocError'
    /** @type {true} */
    this.userError = true
  }
}

/**
 * @param {string} message
 * @param {{ cause?: unknown }} [options]
 */
export function userError(message, options = {}) {
  return new MkadocError(message, options)
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUserError(err) {
  if (!err || typeof err !== 'object') return false
  const e = /** @type {{ userError?: boolean, name?: string, code?: string, message?: string }} */ (
    err
  )
  if (e.userError === true || e.name === 'MkadocError') return true
  // node:util parseArgs validation
  if (typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) return true
  // Existing convention: user-facing throws use a `mkadoc:` message prefix.
  return typeof e.message === 'string' && e.message.startsWith('mkadoc:')
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function formatCliError(err) {
  if (isUserError(err)) {
    const e = /** @type {{ message?: string }} */ (err)
    return e.message || String(err)
  }
  const e = /** @type {{ stack?: string }} */ (err)
  return e?.stack || String(err)
}
