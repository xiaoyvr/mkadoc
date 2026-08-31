import { createRegistry } from './plugin/registry.js'

/**
 * One build/serve session: the explicit home for state that must outlive a
 * single build (architecture review item 1). Created per serve session (or
 * per CLI invocation) and threaded through `createHosts` so rebuilds share
 * it. Nothing session-scoped lives at module scope anymore — the lifetime is
 * the session's, and a future concurrent-build story can give each build its
 * own session.
 *
 * Owned slots:
 * - `registry` — the dependency registry (core module whitelist + plugin
 *   capabilities + memoized resolution). Providers may declare a `key`; the
 *   registry retains a memoized value across rebuilds while the key is
 *   unchanged (e.g. shiki's highlighter) and releases it on key change or
 *   removal from config. `beginLoad`/`endLoad` guard against re-entrant
 *   builds in one session.
 * - `nav` — mkadoc:nav's classifier state: repo-relative pages whose label
 *   feeds the nav, and their last resolved labels. Warmed by each chrome
 *   pass, read by the next rebuild's classifier (nav-label detection without
 *   full rebuilds).
 * - `plugin` — plugin-set bookkeeping for build orchestration: the previous
 *   load's plugin signature + dispose handle, so a changed `plugins` config
 *   disposes the old set before the new one loads.
 *
 * @returns {{
 *   registry: ReturnType<typeof createRegistry>,
 *   nav: { referenced: Set<string>, labels: Map<string, string> },
 *   plugin: { signature: string | null, dispose: (() => Promise<void>) | null },
 * }}
 */
export function createSession() {
  return {
    registry: createRegistry(),
    nav: {
      referenced: new Set(),
      labels: new Map(),
    },
    plugin: {
      signature: null,
      dispose: null,
    },
  }
}
