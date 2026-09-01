import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Core module whitelist — the only modules resolvable by name from plugin
 * dependency lists (and via `host.import`). Curated deliberately: a package
 * being a dependency of mkadoc does NOT expose it to plugins; adding a name
 * here is an explicit API decision. Drift-checked against package.json below,
 * so a whitelist entry can never silently point at a removed dependency.
 *
 * Entries are provider factories returning the module namespace (the same
 * object `import()` yields), so a dep on `'zod'` injects `{ z }` — identical
 * to today's `host.import('zod')`.
 *
 * Core *capabilities* (see `provideCore`) are a separate kind: same DI
 * surface, but not importable via `host.import` and seeded per session
 * (they close over session state).
 */
const CORE_MODULES = {
  zod: () => import('zod'),
  yaml: () => import('yaml'),
}

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
)

for (const name of Object.keys(CORE_MODULES)) {
  if (!(name in (pkg.dependencies ?? {}))) {
    throw new Error(
      `mkadoc: core module whitelist entry "${name}" is not in package.json dependencies`,
    )
  }
}

/**
 * Dependency registry — **session-scoped**: one instance per serve session /
 * CLI invocation, shared across rebuilds. This is what makes expensive
 * provider values (shiki's highlighter) reusable without module-global state:
 *
 * - `provide(name, provider, { key, onRelease })` — a provider with the same
 *   `key` as the currently-memoized one is a no-op (the value is retained
 *   across rebuilds); a different key replaces it, calling `onRelease` on the
 *   old value first.
 * - `provideCore(name, provider)` — core-owned capability (e.g. `site-root`):
 *   never pruned, not shadowable by plugins, resolvable as a DI dependency
 *   but **not** importable via `host.import` (not on the module whitelist).
 * - `beginLoad`/`endLoad` bracket one plugin load. Entries not re-provided in
 *   the current load are pruned at `endLoad` (provider removed from config),
 *   releasing their values; the pair also guards against re-entrant builds in
 *   one session.
 * - resolution is memoized per (name, key): a provider runs at most once per
 *   session while its key is unchanged, and only when something depends on it.
 *
 * @returns {{
 *   beginLoad: () => void,
 *   endLoad: () => void,
 *   provide: (name: string, provider: () => unknown, owner: string, opts?: { key?: string | null, onRelease?: (() => void) | null }) => void,
 *   provideCore: (name: string, provider: () => unknown) => void,
 *   has: (name: string) => boolean,
 *   isCore: (name: string) => boolean,
 *   names: () => string[],
 *   resolve: (name: string) => Promise<unknown>,
 * }}
 */
export function createRegistry() {
  /** @type {Map<string, { source: 'core' | 'core-cap' | 'plugin', owner: string, provider: () => unknown, key: string | null, onRelease: (() => void) | null, value: Promise<unknown> | undefined, gen: number }>} */
  const entries = new Map()
  let generation = 0
  let loading = false

  for (const [name, provider] of Object.entries(CORE_MODULES)) {
    entries.set(name, {
      source: 'core',
      owner: 'mkadoc core',
      provider,
      key: null,
      onRelease: null,
      value: undefined,
      gen: 0,
    })
  }

  return {
    /** Begin a plugin load. Guards against concurrent/re-entrant builds in one session. */
    beginLoad() {
      if (loading) {
        throw new Error(
          'mkadoc: concurrent build in one session — create a separate session per concurrent build',
        )
      }
      loading = true
      generation += 1
    },

    /**
     * Close a plugin load: drop every plugin entry that was not re-provided
     * in it (provider removed from config), releasing its value via
     * `onRelease`. Core whitelist + core capability entries are never pruned.
     */
    endLoad() {
      loading = false
      for (const [name, entry] of entries) {
        if (entry.source === 'core' || entry.source === 'core-cap') continue
        if (entry.gen !== generation) {
          if (entry.value && entry.onRelease) entry.onRelease()
          entries.delete(name)
        }
      }
    },

    /**
     * Seed a core-owned capability (source `'core-cap'`): like the module
     * whitelist it is never pruned and cannot be shadowed by plugins, but
     * unlike the whitelist it is **not** importable via `host.import` — it
     * resolves only as a DI dependency. Use for capabilities that close over
     * session state and must exist from session creation (e.g. the
     * `site-root` command). Call once per session.
     * @param {string} name
     * @param {() => unknown} provider
     */
    provideCore(name, provider) {
      if (entries.has(name)) {
        throw new Error(`mkadoc: core capability "${name}" is already registered`)
      }
      entries.set(name, {
        source: 'core-cap',
        owner: 'mkadoc core',
        provider,
        key: null,
        onRelease: null,
        value: undefined,
        gen: 0,
      })
    },

    /**
     * Register a capability provider. Factory-phase only (enforced by the
     * host's phase gate); the container runs `provider` when a consumer's
     * dependency list references `name`.
     *
     * Re-providing from the same owner with the same `key` retains the
     * memoized value (rebuild with unchanged options); a different `key`
     * replaces it, releasing the old value first. A different owner for an
     * existing name is an error, as is shadowing a core module.
     *
     * @param {string} name
     * @param {() => unknown} provider
     * @param {string} owner locator of the providing plugin
     * @param {{ key?: string | null, onRelease?: (() => void) | null }} [opts]
     */
    provide(name, provider, owner, { key = null, onRelease = null } = {}) {
      if (typeof provider !== 'function') {
        throw new Error(
          `mkadoc: provide("${name}") needs a provider factory (got ${typeof provider})`,
        )
      }
      const existing = entries.get(name)
      if (existing && (existing.source === 'core' || existing.source === 'core-cap')) {
        throw new Error(
          `mkadoc: ${owner} tries to provide "${name}" but it is reserved by mkadoc core (core module whitelist / core capability)`,
        )
      }
      if (existing && existing.source === 'plugin' && existing.owner !== owner) {
        throw new Error(
          `mkadoc: ${owner} tries to provide "${name}" but it is already provided by ${existing.owner}`,
        )
      }
      if (existing && existing.key === key) {
        // Same owner, same key → the memoized value stays valid across rebuilds.
        existing.gen = generation
        return
      }
      if (existing?.value && existing.onRelease) existing.onRelease()
      entries.set(name, {
        source: 'plugin',
        owner,
        provider,
        key,
        onRelease,
        value: undefined,
        gen: generation,
      })
    },

    /** Visible to the current load: core whitelist + core capabilities + capabilities re-provided now. */
    has(name) {
      const entry = entries.get(name)
      return Boolean(
        entry &&
          (entry.source === 'core' || entry.source === 'core-cap' || entry.gen === generation),
      )
    },

    isCore(name) {
      return entries.get(name)?.source === 'core'
    },

    names() {
      return [...entries]
        .filter(([, e]) => e.source === 'core' || e.source === 'core-cap' || e.gen === generation)
        .map(([name]) => name)
    },

    /**
     * Run a provider (at most once per session while its key is unchanged).
     * A failed provider is cleared so the next load can retry it.
     * @param {string} name
     * @returns {Promise<unknown>}
     */
    resolve(name) {
      const entry = entries.get(name)
      if (
        !entry ||
        (entry.source !== 'core' && entry.source !== 'core-cap' && entry.gen !== generation)
      ) {
        const known = this.names().join(', ') || 'none'
        throw new Error(`mkadoc: dependency "${name}" is not provided by anyone (known: ${known})`)
      }
      if (!entry.value) {
        entry.value = Promise.resolve()
          .then(() => entry.provider())
          .catch((err) => {
            entry.value = undefined
            throw err
          })
      }
      return entry.value
    },
  }
}
