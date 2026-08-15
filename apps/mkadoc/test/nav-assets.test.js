import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractMkadocCss } from '../src/chrome.js'

describe('extractMkadocCss', () => {
  it('pulls css blocks and leaves sidebar markup', () => {
    const src = `* xref:index.adoc[Home]

[mkadoc-css]
----
.mkadoc-sidebar a { color: red; }
----
`
    const { css, markupSource } = extractMkadocCss(src)
    assert.match(css, /\.mkadoc-sidebar a/)
    assert.match(markupSource, /xref:index\.adoc/)
    assert.doesNotMatch(markupSource, /mkadoc-css/)
    assert.doesNotMatch(markupSource, /color: red/)
  })

  it('strips ////-delimited css so it cannot render as a listing', () => {
    const src = `* Home

[mkadoc-css]
////
.mkadoc-sidebar a { color: blue; }
////
`
    const { css, markupSource } = extractMkadocCss(src)
    assert.match(css, /color: blue/)
    assert.doesNotMatch(markupSource, /color: blue/)
    assert.doesNotMatch(markupSource, /\[mkadoc-css\]/)
  })

  it('returns empty assets when none present', () => {
    const { css, markupSource } = extractMkadocCss('* Home\n')
    assert.equal(css, '')
    assert.match(markupSource, /\* Home/)
  })
})
