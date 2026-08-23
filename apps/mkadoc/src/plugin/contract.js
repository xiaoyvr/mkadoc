/**
 * Type-only shim for mkadoc internals. Canonical contract types live in the
 * `@mkadoc/plugin-host` package; this module only re-declares them so existing
 * `import('./contract.js')` JSDoc references keep resolving.
 *
 * @typedef {import('@mkadoc/plugin-host').BuildMode} BuildMode
 * @typedef {import('@mkadoc/plugin-host').BuildContext} BuildContext
 * @typedef {import('@mkadoc/plugin-host').CheckResult} CheckResult
 * @typedef {import('@mkadoc/plugin-host').MkadocSource} MkadocSource
 * @typedef {import('@mkadoc/plugin-host').MkadocConfig} MkadocConfig
 * @typedef {import('@mkadoc/plugin-host').MkadocPluginHost} MkadocPluginHost
 * @typedef {import('@mkadoc/plugin-host').MkadocBuildHost} MkadocBuildHost
 * @typedef {import('@mkadoc/plugin-host').MkadocPlugin} MkadocPlugin
 * @typedef {import('@mkadoc/plugin-host').MkadocPluginFactory} MkadocPluginFactory
 */

export {}
