import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatCliError, isUserError, MkadocError, userError } from '../src/errors.js'

describe('CLI error classification', () => {
  it('treats MkadocError and mkadoc: messages as user errors', () => {
    assert.equal(isUserError(userError('mkadoc: config not found: x')), true)
    assert.equal(isUserError(new MkadocError('mkadoc: nope')), true)
    assert.equal(isUserError(new Error('mkadoc: invalid config: fancy')), true)
    assert.equal(isUserError({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION', message: 'bad' }), true)
  })

  it('treats unexpected errors as non-user', () => {
    assert.equal(isUserError(new TypeError('x is not a function')), false)
    assert.equal(isUserError(new Error('boom')), false)
    assert.equal(isUserError(null), false)
  })

  it('formatCliError prints message-only for user errors and stack otherwise', () => {
    assert.equal(formatCliError(userError('mkadoc: bad port')), 'mkadoc: bad port')

    const bug = new Error('unexpected')
    const formatted = formatCliError(bug)
    assert.match(formatted, /unexpected/)
    assert.match(formatted, /Error/)
    assert.ok(formatted.includes('\n') || formatted.includes('at '))
  })
})
