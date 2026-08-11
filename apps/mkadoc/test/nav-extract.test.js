import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractNavChrome } from '../src/plugins/nav.js'

describe('extractNavChrome', () => {
  it('extracts css/js, converts sidebar HTML, and strips tagged blocks', async () => {
    const source = `= Nav

[mkadoc-nav-css]
++++
.nav { color: blue; }
++++

* <<index.adoc,Home>>
* <<guide.adoc,Guide>>

[mkadoc-nav-js]
++++
console.log('nav');
++++
`
    const { css, js, html } = await extractNavChrome(source)

    assert.match(css, /\.nav \{ color: blue; \}/)
    assert.match(js, /console\.log\('nav'\)/)
    assert.match(html, /Home/)
    assert.match(html, /Guide/)
    assert.doesNotMatch(html, /\.nav \{ color: blue; \}/)
    assert.doesNotMatch(html, /console\.log\('nav'\)/)
  })

  it('concatenates multiple css/js blocks after collect-then-remove', async () => {
    const source = `= Nav

[mkadoc-nav-css]
++++
.a{}
++++

[mkadoc-nav-css]
++++
.b{}
++++

Sidebar body.

[mkadoc-nav-js]
++++
1;
++++

[mkadoc-nav-js]
++++
2;
++++
`
    const { css, js, html } = await extractNavChrome(source)
    assert.match(css, /\.a\{\}/)
    assert.match(css, /\.b\{\}/)
    assert.match(js, /1;/)
    assert.match(js, /2;/)
    assert.match(html, /Sidebar body/)
  })
})
