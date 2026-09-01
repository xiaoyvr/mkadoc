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
 * - `registry` — the dependency registry (core module whitelist + core
 *   capabilities + plugin capabilities + memoized resolution). Providers may
 *   declare a `key`; the registry retains a memoized value across rebuilds
 *   while the key is unchanged (e.g. shiki's highlighter) and releases it on
 *   key change or removal from config. `beginLoad`/`endLoad` guard against
 *   re-entrant builds in one session.
 * - `nav` — mkadoc:nav's classifier state: repo-relative pages whose label
 *   feeds the nav, and their last resolved labels. Warmed by each chrome
 *   pass, read by the next rebuild's classifier (nav-label detection without
 *   full rebuilds).
 * - `plugin` — plugin-set bookkeeping for build orchestration: the previous
 *   load's plugin signature + dispose handle, so a changed `plugins` config
 *   disposes the old set before the new one loads.
 * - `build` — the latest build's runtime results that must outlive the
 *   per-build host (e.g. `siteRoot`, where `/` redirects), read by serve
 *   when the dev server handles a request. Written by the core-provided
 *   `site-root` capability (a command plugins call — see `provideCore`),
 *   never by plugins reaching into the session directly.
 *
 * @returns {{
 *   registry: ReturnType<typeof createRegistry>,
 *   nav: { referenced: Set<string>, labels: Map<string, string> },
 *   plugin: { signature: string | null, dispose: (() => Promise<void>) | null },
 *   build: { siteRoot: string | null },
 * }}
 */
export function createSession() {
  const session = {
    registry: createRegistry(),
    nav: {
      referenced: new Set(),
      labels: new Map(),
    },
    plugin: {
      signature: null,
      dispose: null,
    },
    build: {
      siteRoot: null,
    },
  }

  // Core-provided command capability: `site-root` lets plugins set where `/`
  // redirects (mkadoc:nav calls it at chrome time with its first nav entry's
  // href, or null to disable). The injected value is a **function**, not a
  // holder — stable per session (memoized once), only its argument changes
  // per build. Resolved like any DI dep: host.plugin(['site-root'], (set) => …).
  session.registry.provideCore('site-root', () => (href) => {
    session.build.siteRoot = href ?? null
  })

  return session
}
