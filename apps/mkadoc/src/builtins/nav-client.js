;(() => {
  var path = location.pathname
  if (path.endsWith('/')) path += 'index.html'

  function mountMatch(mount) {
    var m = mount || '/'
    var prefix = m.endsWith('/') ? m : m + '/'
    if (path === m || path === m + '.html') return m.length
    if (path.startsWith(prefix)) return m.length
    return -1
  }

  document.querySelectorAll('#mkadoc-articles a').forEach((a) => {
    if (a.classList.contains('mkadoc-source')) return
    if (a.getAttribute('href') === path) a.classList.add('current')
  })

  var root = document.documentElement
  var topbar = document.getElementById('mkadoc-topbar')
  var topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 0
  var articles = document.querySelector('.mkadoc-articles')
  var maxOffset =
    root && articles ? Math.max(articles.getBoundingClientRect().top - topbarBottom, 0) : 0
  var ticking = false

  function updateOffset() {
    ticking = false
    var y = window.scrollY || document.documentElement.scrollTop || 0
    root.style.setProperty('--mkadoc-scroll-offset', Math.min(Math.max(y, 0), maxOffset) + 'px')
  }
  function onScroll() {
    if (ticking) return
    ticking = true
    window.requestAnimationFrame(updateOffset)
  }
  if (root && articles && maxOffset > 0) {
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    updateOffset()
  }

  var sources = Array.prototype.slice.call(document.querySelectorAll('.mkadoc-source'))
  var best = null
  var bestLen = -1
  sources.forEach((source) => {
    var mount = source.getAttribute('data-mount') || '/'
    var len = mountMatch(mount)
    if (len > bestLen) {
      best = mount
      bestLen = len
    }
  })
  if (best == null && sources.length) best = sources[0].getAttribute('data-mount') || '/'
  sources.forEach((source) => {
    if ((source.getAttribute('data-mount') || '/') === best) source.classList.add('is-active')
  })
  document.querySelectorAll('.mkadoc-article-list').forEach((list) => {
    if ((list.getAttribute('data-mount') || '/') === best) list.classList.add('is-active')
  })
})()
