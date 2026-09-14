import { describe, expect, test } from 'bun:test'
import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { Address } from 'viem'
import { createSugarCacheStore } from '../cache'
import { SugarClient } from '../client'
import { normalizeAddress } from '../helpers'
import { stubPublicClient } from '../test-support'
import type { SugarClientCaches } from '../types'
import { SugarCaches, sugarCachesLayer, type SugarCacheLookups } from './caches'
import type { SugarContext } from './context'
import { RpcReader, rpcReaderLayer } from './rpc-executor'

function buildCaches(
  entry: SugarClientCaches,
  lookups: SugarCacheLookups,
  getCtx: () => SugarContext,
) {
  const services = Effect.runSync(Effect.scoped(Layer.build(sugarCachesLayer(entry, lookups, getCtx))))
  return Context.get(services, SugarCaches)
}

function stubLookups(poolLocatorKeys: Address[]): SugarCacheLookups {
  return {
    tokens: () => Effect.succeed([]),
    rawPools: () => Effect.succeed([]),
    pools: () => Effect.succeed([]),
    permit2Address: () => Effect.succeed('0x0000000000000000000000000000000000000001'),
    veNftContracts: () => Effect.succeed({
      veSugar: '0x0000000000000000000000000000000000000002',
      voter: '0x0000000000000000000000000000000000000003',
      votingEscrow: '0x0000000000000000000000000000000000000004',
      governanceToken: '0x0000000000000000000000000000000000000005',
      rewardsDistributor: '0x0000000000000000000000000000000000000006',
    }),
    poolLocator: (_ctx, key) => {
      poolLocatorKeys.push(key)
      return Effect.succeed(undefined)
    },
  }
}

describe('sugarCachesLayer', () => {
  test('reuses shared handles on the same store entry and keeps per-client handles fresh', () => {
    const entry: SugarClientCaches = { priceRateCache: new Map(), ttlMs: 60_000 }
    const recorded: Address[] = []
    const getCtx = (): SugarContext => {
      throw new Error('cache construction must not need a client context')
    }
    const first = buildCaches(entry, stubLookups(recorded), getCtx)
    const second = buildCaches(entry, stubLookups(recorded), getCtx)

    expect(second.tokens).toBe(first.tokens)
    expect(second.rawPools).toBe(first.rawPools)
    expect(second.pools).toBe(first.pools)
    expect(second.permit2Address).toBe(first.permit2Address)
    expect(second.veNftContracts).not.toBe(first.veNftContracts)
    expect(second.resolvedPoolLocators).not.toBe(first.resolvedPoolLocators)
  })

  test('rpcReaderLayer applies the policy options to the built executor', () => {
    const services = Effect.runSync(Effect.scoped(Layer.build(rpcReaderLayer({ deadlineMs: 1_234 }))))
    const rpc = Context.get(services, RpcReader)
    expect(rpc.policy.deadlineMs).toBe(1_234)
  })

  test('the locator cache normalizes the cache key before the pool lookup', async () => {
    const cacheStore = createSugarCacheStore({ ttlMs: 60_000 })
    const client = new SugarClient(10, {
      cacheStore,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') return 0n
          if (request.functionName === 'forSwaps') return []
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })
    await client.getPoolsForSwaps()
    const entry = cacheStore.cachesFor(client.settings.chainId, client.settings.rpcUrl, JSON.stringify(client.settings))
    const ctx = entry.activeContext
    if (!ctx) throw new Error('shared read did not publish the client context')
    const recorded: Address[] = []
    const handles = buildCaches(entry, stubLookups(recorded), () => ctx)

    const raw = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    await Effect.runPromise(Cache.get(handles.resolvedPoolLocators, raw))
    expect(recorded).toEqual([normalizeAddress(raw)])
  })
})
