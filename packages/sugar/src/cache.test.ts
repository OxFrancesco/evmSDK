import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { createSugarCacheStore } from './cache'
import { SugarClient } from './client'
import { stubPublicClient } from './test-support'

function countingClient(counters: { count: number; forSwaps: number }): PublicClient {
  return stubPublicClient({
    readContract: async (request) => {
      if (request.functionName === 'count') {
        counters.count += 1
        return 1n
      }
      if (request.functionName === 'forSwaps') {
        counters.forSwaps += 1
        return Number(request.args?.[1]) === 0
          ? [[
              '0x2000000000000000000000000000000000000003',
              -1,
              '0x2000000000000000000000000000000000000001',
              '0x2000000000000000000000000000000000000002',
              '0x2000000000000000000000000000000000000004',
            ]]
          : []
      }
      throw new Error(`Unexpected read: ${request.functionName}`)
    },
  })
}

describe('Sugar cache store', () => {
  test('shares pool reads across client instances on the same chain and RPC', async () => {
    const counters = { count: 0, forSwaps: 0 }
    const cacheStore = createSugarCacheStore({ ttlMs: 60_000 })
    const first = new SugarClient(10, { cacheStore, publicClient: countingClient(counters) })
    const second = new SugarClient(10, { cacheStore, publicClient: countingClient(counters) })

    const firstPools = await first.getPoolsForSwaps()
    const secondPools = await second.getPoolsForSwaps()

    // One paginated scan (a single `count` read) serves both clients.
    expect(firstPools).toHaveLength(1)
    expect(secondPools).toBe(firstPools)
    expect(counters.count).toBe(1)
    const pagesPerScan = counters.forSwaps

    await second.getPoolsForSwaps()
    expect(counters.forSwaps).toBe(pagesPerScan)
  })

  test('expires shared caches after the TTL', async () => {
    const counters = { count: 0, forSwaps: 0 }
    const cacheStore = createSugarCacheStore({ ttlMs: 1 })
    const client = new SugarClient(10, { cacheStore, publicClient: countingClient(counters) })
    const previous = await client.getPoolsForSwaps()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await client.getPoolsForSwaps()).not.toBe(previous)

    expect(counters.count).toBe(2)
  })

  test('does not cache failed pool reads', async () => {
    const counters = { count: 0, forSwaps: 0 }
    const cacheStore = createSugarCacheStore({ ttlMs: 60_000 })
    const broken = new SugarClient(10, {
      cacheStore,
      publicClient: stubPublicClient({
        readContract: async () => {
          throw new Error('nope')
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })
    await expect(broken.getPoolsForSwaps()).rejects.toThrow()

    const healthy = new SugarClient(10, { cacheStore, publicClient: countingClient(counters) })
    await expect(healthy.getPoolsForSwaps()).resolves.toHaveLength(1)
  })

  test('isolates caches per chain', async () => {
    const opCounters = { count: 0, forSwaps: 0 }
    const baseCounters = { count: 0, forSwaps: 0 }
    const cacheStore = createSugarCacheStore({ ttlMs: 60_000 })
    await new SugarClient(10, { cacheStore, publicClient: countingClient(opCounters) }).getPoolsForSwaps()
    await new SugarClient(8453, { cacheStore, publicClient: countingClient(baseCounters) }).getPoolsForSwaps()

    expect(opCounters.count).toBe(1)
    expect(baseCounters.count).toBe(1)
  })

  test('rejects a non-positive TTL', () => {
    expect(() => createSugarCacheStore({ ttlMs: 0 })).toThrow('ttlMs')
  })
})
