import { escapeHtml, escapeHtmlAttr } from './html-utils.js'
import { THEME_CSS_HREF } from './theme.js'

const FONT_LINK =
  'https://fonts.googleapis.com/css?family=Open+Sans:300,300italic,400,400italic,600,600italic%7CNoto+Serif:400,400italic,700,700italic%7CNoto+Sans+Mono:400,700'

function renderLinkTag(link) {
  const attrs = Object.entries(link)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeHtmlAttr(v)}"`))
    .join(' ')
  return `<link ${attrs}>`
}

function renderScriptTag(script) {
  const { src, defer, async: isAsync, ...rest } = script
  const parts = [`src="${escapeHtmlAttr(src)}"`]
  if (defer) parts.push('defer')
  if (isAsync) parts.push('async')
  for (const [k, v] of Object.entries(rest)) {
    parts.push(v === true ? k : `${k}="${escapeHtmlAttr(v)}"`)
  }
  return `<script ${parts.join(' ')}></script>`
}

/**
 * Core page assembly. Renderers return the article `body`; core wraps it into
 * the full HTML document (default wrapper reproduces Asciidoctor's standalone
 * structure so the default theme keeps AsciiDoc's look).
 *
 * @param {{
 *   title: string,
 *   lang?: string,
 *   bodyClass?: string,
 *   body: string,
 *   head?: string,
 *   headLinks?: object[],
 *   headScripts?: object[],
 *   chromeBody?: string,
 *   themeCssHref?: string,
 * }} page
 * @returns {string}
 */
export function assemblePage({
  title,
  lang = 'en',
  bodyClass = 'article',
  body,
  head = '',
  headLinks = [],
  headScripts = [],
  chromeBody = '',
  themeCssHref = THEME_CSS_HREF,
}) {
  const linkTags = headLinks.map(renderLinkTag)
  const scriptTags = headScripts.map(renderScriptTag)
  const extras = [...linkTags, ...scriptTags, head].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="${escapeHtmlAttr(lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${FONT_LINK}">
<link rel="stylesheet" href="${escapeHtmlAttr(themeCssHref)}">
${extras}${extras ? '\n' : ''}</head>
<body class="${escapeHtmlAttr(bodyClass)}">
${chromeBody}
${body}
</body>
</html>
`
}
