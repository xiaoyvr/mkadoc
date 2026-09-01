import fs from 'node:fs'
import path from 'node:path'
import { relToRoot } from '../../fs-utils.js'
import {
  buildFolder,
  findPageFile,
  flattenPageItems,
  metaLabelFor,
  pageLabelForRel,
  readNavYaml,
} from './model.js'

/**
 * Session-scoped nav classifier state — used by the async classifier to
 * detect `:nav_label:`/title changes on nav-referenced pages without forcing
 * a full rebuild on content-only edits. It is session state that must outlive
 * the per-build plugin instances (the classifier compares against the
 * previous build's labels), so it lives in the session (host.session.nav)
 * rather than module scope: warmed by each chrome pass, read by the next
 * rebuild's classifier. Safe today because the CLI `build` is always
 * forceFull, so this classifier is only consulted under `serve`, where the
 * caches are warmed by the initial build's chrome pass. A fresh session has
 * no history — if a non-forceFull CLI path is ever added, this needs
 * revisiting.
 */

/** Session-scoped nav classifier state (see src/session.js). */
export function navState(host) {
  return host.session.nav
}

/**
 * Update the classifier state with the pages whose labels feed this source's nav.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {import('../../sources.js').MkadocSource} source
 */
export async function collectNavReferenced(host, source) {
  // Rich `_nav.adoc` labels are inline, not page-derived — nothing to track.
  if (fs.existsSync(path.join(host.root, source.path, '_nav.adoc'))) return

  const items = readNavYaml(host, source)
  if (items?.length) {
    for (const item of flattenPageItems(items)) {
      const found = findPageFile(host, source, item.page)
      if (!found) continue
      const rel = relToRoot(found.abs, host.root)
      navState(host).referenced.add(rel)
      const label = await metaLabelFor(host, found.abs, found.renderer)
      navState(host).labels.set(rel, label)
    }
    return
  }

  // Auto-nav: every page in the convention tree feeds a label.
  const root = await buildFolder(host, source, source.path)
  await collectAutoNavRefs(host, root)
}

/**
 * Walk an auto-nav tree and record each page's repo path + resolved label.
 * @param {import('@mkadoc/plugin-host').MkadocPluginHost} host
 * @param {{ rel: string | null, children: object[] }} node
 */
async function collectAutoNavRefs(host, node) {
  if (node.rel) {
    navState(host).referenced.add(node.rel)
    navState(host).labels.set(node.rel, await pageLabelForRel(host, node.rel))
  }
  for (const child of node.children) {
    await collectAutoNavRefs(host, child)
  }
}
