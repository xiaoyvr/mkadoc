import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { TOPBAR_JS } from '../src/builtins/topbar.js'

const savedGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  addEventListener: globalThis.addEventListener,
}

after(() => {
  globalThis.document = savedGlobals.document
  globalThis.window = savedGlobals.window
  globalThis.addEventListener = savedGlobals.addEventListener
})

/**
 * Minimal DOM double sufficient to execute TOPBAR_JS. Returns a driver whose
 * `scrollTo(y)` fires a scroll event on the stubbed window.
 * @param {{ docTitle?: string, siteTitle?: string, navHeight?: number | null }} [opts]
 */
function createFakeDom({
  docTitle = 'Doc Title',
  siteTitle = 'Site Brand',
  navHeight = null,
} = {}) {
  const listeners = {}
  function el(attrs = {}) {
    return {
      textContent: '',
      offsetHeight: 0,
      getAttribute: (k) => (Object.hasOwn(attrs, k) ? attrs[k] : null),
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c)
        },
        remove(c) {
          this._set.delete(c)
        },
        toggle(c, v) {
          v ? this._set.add(c) : this._set.delete(c)
        },
      },
    }
  }

  const root = el()
  const body = el(docTitle ? { 'data-doc-title': docTitle } : {})
  const topbar = el()
  topbar.offsetHeight = 40
  const brandEl = el()
  const brand = el()
  brand.querySelector = () => brandEl
  brand.getAttribute = (k) => (k === 'data-site-title' ? siteTitle : null)
  const nav = navHeight === null ? null : Object.assign(el(), { offsetHeight: navHeight })

  globalThis.document = {
    documentElement: root,
    body,
    getElementById: (id) => (id === 'mkadoc-topbar' ? topbar : null),
    querySelector: (sel) => {
      if (sel === '.mkadoc-sources') return nav
      if (sel === '.mkadoc-brand') return brand
      return null
    },
  }
  globalThis.window = {
    scrollY: 0,
    requestAnimationFrame: (fn) => fn(),
    addEventListener: (ev, fn) => {
      listeners[ev] = fn
    },
  }
  globalThis.addEventListener = () => {}

  return {
    scrollTo(y) {
      window.scrollY = y
      listeners.scroll?.()
    },
    get brandText() {
      return brandEl.textContent
    },
    get scrolled() {
      return root.classList._set.has('mkadoc-scrolled')
    },
  }
}

describe('TOPBAR_JS brand swap', () => {
  it('swaps the brand to the doc title once scrolled past the topbar (no nav)', () => {
    const dom = createFakeDom({ docTitle: 'Markdown Home' })
    new Function(TOPBAR_JS)()

    assert.equal(dom.brandText, 'Site Brand')
    dom.scrollTo(10)
    assert.equal(dom.brandText, 'Site Brand', 'below the topbar threshold')
    dom.scrollTo(41)
    assert.equal(dom.brandText, 'Markdown Home')
  })

  it('never swaps when the page has no title', () => {
    const dom = createFakeDom({ docTitle: '' })
    new Function(TOPBAR_JS)()

    dom.scrollTo(500)
    assert.equal(dom.brandText, 'Site Brand')
    assert.equal(dom.scrolled, false, 'no nav → no scrolled class toggling')
  })

  it('uses the sources-nav height as the swap threshold when nav is present', () => {
    const dom = createFakeDom({ docTitle: 'Guide', navHeight: 300 })
    new Function(TOPBAR_JS)()

    assert.equal(dom.scrolled, false)
    dom.scrollTo(150)
    assert.equal(dom.brandText, 'Site Brand', 'below nav height')
    assert.equal(dom.scrolled, false)
    dom.scrollTo(350)
    assert.equal(dom.brandText, 'Guide')
    assert.equal(dom.scrolled, true, 'mkadoc-scrolled toggled at the same threshold')
  })

  it('swaps back to the site brand when scrolled back up', () => {
    const dom = createFakeDom({ docTitle: 'Doc Title' })
    new Function(TOPBAR_JS)()

    dom.scrollTo(100)
    assert.equal(dom.brandText, 'Doc Title')
    dom.scrollTo(0)
    assert.equal(dom.brandText, 'Site Brand')
  })
})
