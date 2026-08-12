import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatCliError } from '../src/errors.js'

describe('CLI error classification', () => {
  it('formatCliError prints message-only for user errors and stack otherwise', () => {
    assert.equal(formatCliError(new Error('mkadoc: bad port')), 'mkadoc: bad port')
    assert.equal(
      formatCliError(new Error('mkadoc: invalid config: fancy')),
      'mkadoc: invalid config: fancy',
    )
    assert.equal(formatCliError({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION', message: 'bad' }), 'bad')

    const bug = new Error('unexpected')
    const formatted = formatCliError(bug)
    assert.match(formatted, /unexpected/)
    assert.match(formatted, /Error/)
    assert.ok(formatted.includes('\n') || formatted.includes('at '))
  })
})
