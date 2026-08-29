import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {Record<string, string>} files path → contents (relative to temp root)
 * @returns {string} absolute temp project root
 */
export function createTempProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkadoc-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

export function rmTempProject(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

/**
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T> | T} fn
 */
export async function withTempProject(files, fn) {
  const root = createTempProject(files)
  try {
    return await fn(root)
  } finally {
    rmTempProject(root)
  }
}

/**
 * Poll until `fn` returns a truthy value or timeout.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ timeout?: number, interval?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms (last=${String(last)})`)
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Plain YAML config body (mkadoc v1 config format). */
export function yamlConfig(yamlBody) {
  return yamlBody.trim()
}

/** Minimal no-plugin fixture used by smoke tests. */
export function smokeFixture(overrides = {}) {
  return {
    'mkadoc.yaml': yamlConfig(`sources:
  - docs
output: site
plugins: {}
serve:
  remote: false
  port: 8765
`),
    'docs/index.adoc': `= Smoke Index

MARKER_INDEX_V1
`,
    'docs/guide.adoc': `= Smoke Guide

MARKER_GUIDE_V1
`,
    'docs/_partial.adoc': `= Partial

This is not a page.
`,
    ...overrides,
  }
}
