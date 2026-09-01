import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { NAV_JS } from '../src/builtins/nav.js'

const savedGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  location: globalThis.location,
}

after(() => {
  globalThis.document = savedGlobals.document
  globalThis.window = savedGlobals.window
  globalThis.location = savedGlobals.location
})

/**
 * Minimal DOM double sufficient to execute NAV_JS: current-article marking,
 * active-source selection, and the scroll-offset driver.
 * @param {{ path?: string, links?: string[], sources?: (string | null)[], lists?: string[], articlesTop?: number | null }} [opts]
 */
function createFakeDom({
  path = '/docs/index.html',
  links = [],
  sources = [],
  lists = [],
  articlesTop = null,
} = {}) {
  const listeners = {}
  const styleProps = {}

  const el = (attrs = {}) => ({
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
      contains(c) {
        return this._set.has(c)
      },
    },
  })

  const root = el()
  root.style = { setProperty: (k, v) => (styleProps[k] = v) }
  const topbar = el()
  topbar.getBoundingClientRect = () => ({ bottom: 40 })
  const articles = articlesTop === null ? null : el()
  if (articles) articles.getBoundingClientRect = () => ({ top: articlesTop })

  const linkEls = links.map((href) => el({ href }))
  const sourceEls = sources.map((mount) => el(mount === null ? {} : { 'data-mount': mount }))
  const listEls = lists.map((mount) => el(mount === null ? {} : { 'data-mount': mount }))

  globalThis.location = { pathname: path }
  globalThis.document = {
    documentElement: root,
    getElementById: (id) => (id === 'mkadoc-topbar' ? topbar : null),
    querySelector: (sel) => (sel === '.mkadoc-articles' ? articles : null),
    querySelectorAll: (sel) => {
      if (sel === '#mkadoc-articles a') return linkEls
      if (sel === '.mkadoc-source') return sourceEls
      if (sel === '.mkadoc-article-list') return listEls
      return []
    },
  }
  globalThis.window = {
    scrollY: 0,
    requestAnimationFrame: (fn) => fn(),
    addEventListener: (ev, fn) => {
      listeners[ev] = fn
    },
  }

  return {
    links: linkEls,
    sources: sourceEls,
    lists: listEls,
    styleProps,
    scrollTo(y) {
      window.scrollY = y
      listeners.scroll?.()
    },
  }
}

describe('NAV_JS site nav runtime', () => {
  it('marks the current article link', () => {
    const dom = createFakeDom({
      path: '/docs/guide.html',
      links: ['/docs/index.html', '/docs/guide.html'],
    })
    new Function(NAV_JS)()

    assert.equal(dom.links[0].classList.contains('current'), false)
    assert.equal(dom.links[1].classList.contains('current'), true)
  })

  it('activates the source whose mount matches the path (longest match wins)', () => {
    const dom = createFakeDom({
      path: '/apps/mkadoc/docs/index.html',
      sources: ['/docs', '/apps/mkadoc/docs'],
      lists: ['/docs', '/apps/mkadoc/docs'],
    })
    new Function(NAV_JS)()

    assert.equal(dom.sources[0].classList.contains('is-active'), false)
    assert.equal(dom.sources[1].classList.contains('is-active'), true)
    assert.equal(dom.lists[0].classList.contains('is-active'), false)
    assert.equal(dom.lists[1].classList.contains('is-active'), true)
  })

  it('falls back to the first source when no mount matches', () => {
    const dom = createFakeDom({
      path: '/unrelated/page.html',
      sources: ['/docs', '/apps/mkadoc/docs'],
      lists: ['/docs', '/apps/mkadoc/docs'],
    })
    new Function(NAV_JS)()

    assert.equal(dom.sources[0].classList.contains('is-active'), true)
    assert.equal(dom.lists[0].classList.contains('is-active'), true)
  })

  it('drives --mkadoc-scroll-offset, clamped to the articles offset', () => {
    const dom = createFakeDom({ path: '/docs/index.html', articlesTop: 100 })
    new Function(NAV_JS)()

    dom.scrollTo(30)
    assert.equal(dom.styleProps['--mkadoc-scroll-offset'], '30px')
    dom.scrollTo(500)
    assert.equal(dom.styleProps['--mkadoc-scroll-offset'], '60px', 'clamped to topbarBottom offset')
  })
})
