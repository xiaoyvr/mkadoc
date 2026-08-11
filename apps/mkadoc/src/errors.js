class MkadocError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'MkadocError'
    this.userError = true
  }
}

export function userError(message, options = {}) {
  return new MkadocError(message, options)
}

function isUserError(err) {
  if (!err || typeof err !== 'object') return false
  if (err.userError === true || err.name === 'MkadocError') return true
  if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) return true
  return typeof err.message === 'string' && err.message.startsWith('mkadoc:')
}

export function formatCliError(err) {
  if (isUserError(err)) {
    return err.message || String(err)
  }
  return err?.stack || String(err)
}
