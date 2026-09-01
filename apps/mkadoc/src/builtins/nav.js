import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { resolveSiteAsset, writeIfChanged } from '../fs-utils.js'
import { parsePluginOptions } from '../plugin/options.js'
import { readThemeOverride, themeDirForSource } from '../theme.js'
import { buildArticlesHtml, NAV_JS, readNavCssBundle, sourcesBarHtml } from './nav/html.js'
import { pageLabelForRel, readNavYaml, resolveSourceEntry } from './nav/model.js'
import { collectNavReferenced, navState } from './nav/state.js'

// Re-exported for tests (nav-js.test.js executes the client runtime).
export { NAV_JS }

/**
 * mkadoc:nav — site navigation: the level-1 source bar (one link per source)
 * and the level-2 article sidebar (per-source lists). The nav data model
 * lives in `nav/model.js` (auto-nav tree + `_nav.yaml`), rendering in
 * `nav/html.js`, and the session-scoped label classifier in `nav/state.js`;
 * this file only wires them into the plugin lifecycle.
 */

const OptionsSchema = z.object({}).strict()

const CSS_HREF = '/styles/nav.css'
const JS_HREF = '/styles/nav.js'

/** Is `relPath` the first source's `_theme/nav.css` override? */
function isNavCssPath(cfg, relPath) {
  const first = cfg.sources[0]
  if (!first) return false
  return relPath === `${themeDirForSource(first)}/nav.css`
}

/** @type {import('@mkadoc/plugin-host').MkadocPluginFactory} */
export default function navPlugin(rawOptions = {}, host) {
  parsePluginOptions('mkadoc:nav', OptionsSchema, rawOptions)

  // `site-root` is a core-provided command capability: nav decides where `/`
  // redirects and calls it at chrome time with the current first nav entry.
  // The injected value is a function, not a holder — see plugins.adoc.
  return host.plugin(['site-root'], (setSiteRoot) => ({
    name: 'nav',

    async setup(host) {
      for (const source of host.config.sources) {
        host.registerSiteWideDep(`${source.path}/_nav.adoc`)
        host.registerSiteWideDep(`${source.path}/_nav.yaml`)
      }

      // A nav-referenced page forces a full rebuild only when its label
      // (`:nav_label:`/title) actually changed — not on content-only edits.
      const { referenced, labels } = navState(host)
      host.registerClassifier(async (relPath) => {
        if (!referenced.has(relPath)) return null
        const current = await pageLabelForRel(host, relPath)
        return current !== (labels.get(relPath) ?? '') ? 'full' : null
      })
    },

    async contributeChrome(host, { mode, paths = [] }) {
      const cssAsset = resolveSiteAsset(host.root, host.config.output, CSS_HREF)
      const jsAsset = resolveSiteAsset(host.root, host.config.output, JS_HREF)

      // `_theme/nav.css` only changes the linked stylesheet — rewrite the CSS
      // bundle without a full header/page rebuild on an assets-only pass
      // (mirrors mkadoc:topbar's handling of `_theme/topbar.css`).
      if (mode === 'assets') {
        const relPaths = paths.map((p) => host.relToRoot(p))
        if (relPaths.some((p) => isNavCssPath(host.config, p))) {
          writeIfChanged(cssAsset.absPath, await readNavCssBundle(host))
        }
        return
      }

      writeIfChanged(cssAsset.absPath, await readNavCssBundle(host))
      writeIfChanged(jsAsset.absPath, `${NAV_JS}\n`)
      host.contributeHead({
        links: [{ rel: 'stylesheet', href: cssAsset.href }],
        scripts: [{ src: jsAsset.href, defer: true }],
      })

      const entries = []
      for (const source of host.config.sources) {
        entries.push({ source, ...(await resolveSourceEntry(host, source)) })
      }

      // Refresh classifier state for the next rebuild.
      const { referenced, labels } = navState(host)
      referenced.clear()
      labels.clear()
      for (const source of host.config.sources) {
        await collectNavReferenced(host, source)
      }

      // Nav-owned home: where `/` redirects — via the core-provided
      // `site-root` command. Serve reads the session slot after each build.
      setSiteRoot(entries[0]?.href ?? null)

      host.contributeChromeBody(
        `<nav class="mkadoc-sources" aria-label="Sources">\n${sourcesBarHtml(entries)}\n</nav>\n${await buildArticlesHtml(host)}`,
      )
    },

    async check(host) {
      const notes = []
      let ok = host.config.sources.length > 0
      const first = host.config.sources[0]
      if (first) {
        const override = readThemeOverride(host.root, first, 'nav.css')
        notes.push(
          override
            ? `${themeDirForSource(first)}/nav.css style overrides ok`
            : 'nav using plugin CSS defaults',
        )
      }

      for (const source of host.config.sources) {
        const adocPath = path.join(host.root, source.path, '_nav.adoc')
        const yamlPath = path.join(host.root, source.path, '_nav.yaml')
        if (fs.existsSync(adocPath)) {
          notes.push(`${source.path}/_nav.adoc ok`)
        } else if (fs.existsSync(yamlPath)) {
          try {
            readNavYaml(host, source)
            notes.push(`${source.path}/_nav.yaml ok`)
          } catch {
            ok = false
            notes.push(`${source.path}/_nav.yaml invalid`)
          }
        } else {
          notes.push(`_nav missing (auto nav)`)
        }
      }

      return { ok, message: notes.join('; ') || 'nav ok' }
    },
  }))
}
