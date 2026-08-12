function isUserError(err) {
  if (!err || typeof err !== 'object') return false
  if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) return true
  return typeof err.message === 'string' && err.message.startsWith('mkadoc:')
}

export function formatCliError(err) {
  if (isUserError(err)) {
    return err.message || String(err)
  }
  return err?.stack || String(err)
}
