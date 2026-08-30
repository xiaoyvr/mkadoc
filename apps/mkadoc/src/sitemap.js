import path from 'node:path'
import { writeIfChanged } from './fs-utils.js'
import { escapeHtml, escapeHtmlAttr } from './html-utils.js'
import { pageMeta } from './meta-cache.js'
import { assemblePage } from './page.js'
import { listSourcePages, pageToHref } from './sources.js'

/**
 * Core default home: generate `<output>/index.html` as a site map — every
 * page grouped by source. Nav (via `site-root`) redirects `/` away from this
 * when enabled; without nav, `/` serves this page.
 *
 * @param {import('./config.js').MkadocConfig} cfg
 * @param {import('@mkadoc/plugin-host').MkadocBuildHost} host
 */
export async function writeSiteIndex(cfg, host) {
  const allPages = listSourcePages(cfg.root, cfg.sources, {
    rendererForPath: host.rendererForPath,
  })

  const groups = []
  for (const source of cfg.sources) {
    const pages = allPages.filter(({ source: s }) => s === source)
    const items = []
    for (const { page } of pages) {
      const renderer = host.rendererForPath(page)
      const abs = path.join(cfg.root, page)
      let title = path.basename(page, path.extname(page))
      if (renderer) {
        try {
          const meta = await pageMeta(abs, renderer)
          if (meta.title) title = meta.title
        } catch {
          // unreadable page — keep the basename fallback
        }
      }
      items.push({ title, href: pageToHref(source, page) })
    }

    items.sort((a, b) => a.title.localeCompare(b.title))
    const listHtml = items.length
      ? `<ul>\n${items.map((i) => `<li><a href="${escapeHtmlAttr(i.href)}">${escapeHtml(i.title)}</a></li>`).join('\n')}\n</ul>`
      : '<p><em>No pages</em></p>'
    groups.push(`<h2>${escapeHtml(source.path)}</h2>\n${listHtml}`)
  }

  const brand = cfg.site.brand
  const body = `<h1>${escapeHtml(brand)}</h1>\n${groups.join('\n')}\n`

  const html = assemblePage({
    title: `${brand} — Index`,
    body,
    headLinks: [...host.headLinks],
    headScripts: [...host.headScripts],
    chromeBody: host.chromeBody.filter(Boolean).join('\n').trim(),
  })

  writeIfChanged(path.join(cfg.root, cfg.output, 'index.html'), html)
}
