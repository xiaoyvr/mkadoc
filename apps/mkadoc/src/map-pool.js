import os from 'node:os'

export function defaultPoolConcurrency(max = 4) {
  const n =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return Math.max(1, Math.min(max, n || 1))
}

export async function mapPool(items, limit, fn) {
  if (items.length === 0) return
  const workers = Math.min(Math.max(1, limit), items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
}
