import { parse } from 'node-html-parser'

/**
 * Parse an HTML fragment or document for test assertions.
 * @param {string} html
 */
export function parseHtml(html) {
  return parse(html)
}
