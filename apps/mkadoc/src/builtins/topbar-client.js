;(() => {
  var root = document.documentElement
  var topbar = document.getElementById('mkadoc-topbar')
  var sourcesNav = document.querySelector('.mkadoc-sources')
  var sourcesHeight = sourcesNav ? sourcesNav.offsetHeight : 0
  var brand = document.querySelector('.mkadoc-brand')
  var brandEl = brand ? brand.querySelector('p') : null
  var siteTitle = (brand ? brand.getAttribute('data-site-title') : '') || ''
  // Core-owned, renderer-agnostic: the page wrapper sets data-doc-title from
  // RenderOutput.title, so chrome never parses renderer body markup (a
  // renderer may title with h1, h2, or nothing at all).
  var docTitle = String(document.body.getAttribute('data-doc-title') || '').trim()
  var ticking = false

  function setBrand(text) {
    if (!brandEl || brandEl.textContent === text) return
    brandEl.textContent = text
    brandEl.classList.remove('mkadoc-brand-swap')
    void brandEl.offsetWidth
    brandEl.classList.add('mkadoc-brand-swap')
  }

  function updateBrand() {
    ticking = false
    var y = window.scrollY || document.documentElement.scrollTop || 0
    if (sourcesNav) root.classList.toggle('mkadoc-scrolled', y >= sourcesHeight)
    if (!topbar || !docTitle) {
      setBrand(siteTitle)
      return
    }
    // Swap once scrolled past the nav (or past the topbar when there is no
    // nav) — a pure scroll threshold, no body-structure measurement.
    var past = y >= (sourcesNav ? sourcesHeight : topbar.offsetHeight)
    setBrand(past ? docTitle : siteTitle)
  }

  function onScroll() {
    if (ticking) return
    ticking = true
    window.requestAnimationFrame(updateBrand)
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  updateBrand()
})()
