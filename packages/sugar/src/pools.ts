// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Cache from 'effect/Cache'
import * as Effect from 'effect/Effect'
import type { Address } from 'viem'
import { abis } from './abis'
import { addressKey, normalizeAddress, tupleValues } from './helpers'
import { makeReadCache, makeSharedReadCache, sharedCacheGet } from './internal/caches'
import type { ResolvedPoolLocator, SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { paginate } from './internal/pagination'
import { epochFromTuple, poolForSwapFromTuple, preparePools, prepareTokens } from './models'
import {
  ADDRESS_ZERO,
  type LiquidityPool,
  type Price,
  type SugarPoolLocatorKey,
  type Token,
} from './types'

export const getRawPools = Effect.fn('Sugar.Pools.getRawPools')(function* (
  ctx: SugarContext,
  forSwaps = false,
) {
  const cache = ctx.caches.rawPoolCache ??= yield* makeSharedReadCache(ctx.caches, (active, key: boolean) =>
    paginate(active, key ? 'forSwaps' : 'all', (limit, offset) => active.readTask<unknown[]>(
      active.settings.sugarContractAddress,
      abis.sugar,
      key ? 'forSwaps' : 'all',
      key ? [limit, offset] : [limit, offset, 0],
    )),
  )
  return yield* sharedCacheGet(ctx, cache, forSwaps)
})

/**
 * The `forSwaps` key selects the cached representation: `false` hydrates full
 * LiquidityPool records, `true` keeps the compact for-swaps tuples. The
 * SugarClient facade narrows the union through its overloads.
 */
export const getPools = Effect.fn('Sugar.Pools.getPools')(function* (
  ctx: SugarContext,
  forSwaps = false,
) {
  const cache = ctx.caches.poolCache ??= yield* makeSharedReadCache(ctx.caches, (active, key: boolean) =>
    Effect.gen(function* () {
      const raw = yield* clientCall(() => active.client.getRawPools(key))
      if (key) return raw.map((pool) => poolForSwapFromTuple(pool, active.settings))
      const tokens = yield* clientCall(() => active.client.getAllTokens())
      const prices = yield* clientCall(() => active.client.getPrices(tokens))
      return preparePools(raw, tokens, prices, active.settings)
    }),
  )
  return yield* sharedCacheGet(ctx, cache, forSwaps)
})

export const getPoolsForSwaps = Effect.fn('Sugar.Pools.getPoolsForSwaps')(function* (
  ctx: SugarContext,
) {
  return yield* clientCall(() => ctx.client.getPools(true))
})

export const getPoolByAddress = Effect.fn('Sugar.Pools.getPoolByAddress')(function* (
  ctx: SugarContext,
  address: Address | string,
) {
  const resolved = yield* resolvePoolLocator(ctx, normalizeAddress(address))
  if (!resolved) return undefined
  const rawPool = resolved.rawPool

  const values = tupleValues(rawPool)
  const requestedAddresses = [
    String(values[7]),
    String(values[10]),
    String(values[20]),
    ctx.settings.stableTokenAddress,
  ]
    .filter((value) => /^0x[0-9a-fA-F]{40}$/.test(value))
    .map(normalizeAddress)
  const addresses = [
    ...new Map(requestedAddresses.map((value) => [addressKey(value), value])).values(),
  ]
  const rawTokens = yield* ctx.read<unknown[]>(
    ctx.settings.sugarContractAddress,
    abis.sugar,
    'tokens',
    [BigInt(addresses.length), 0n, ADDRESS_ZERO, addresses],
  )
  const tokens = prepareTokens(rawTokens, ctx.settings)
  const prices = yield* clientCall(() => ctx.client.getPrices(tokens))
  const pools = preparePools([rawPool], tokens, prices, ctx.settings)
  return pools[0]
})

function poolLocatorKey(ctx: SugarContext, poolAddress: Address): SugarPoolLocatorKey {
  return {
    chainId: ctx.settings.chainId,
    sugarContractAddress: ctx.settings.sugarContractAddress,
    poolAddress,
  }
}

const rawPoolAtOffset = Effect.fn('Sugar.Pools.rawPoolAtOffset')(function* (
  ctx: SugarContext,
  offset: number,
) {
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined
  const page = yield* ctx.read<unknown[]>(
    ctx.settings.sugarContractAddress,
    abis.sugar,
    'all',
    [1, offset, 0],
  )
  return page[0]
})

function rawPoolMatches<T>(rawPool: T, poolAddress: Address): boolean {
  return addressKey(String(tupleValues(rawPool)[0])) === addressKey(poolAddress)
}

/** Best-effort store access: a cache outage must not break on-chain reads. */
const storedLocatorOffset = Effect.fn('Sugar.Pools.storedLocatorOffset')(function* (
  ctx: SugarContext,
  key: SugarPoolLocatorKey,
) {
  if (!ctx.poolLocatorStore) return undefined
  const store = ctx.poolLocatorStore
  return yield* Effect.tryPromise(() => store.get(key)).pipe(
    Effect.map((locator) => locator?.offset),
    Effect.catch(() => Effect.succeed(undefined)),
  )
})

const lookupPoolLocator = Effect.fn('Sugar.Pools.lookupPoolLocator')(function* (
  ctx: SugarContext,
  poolAddress: Address,
) {
  const key = poolLocatorKey(ctx, poolAddress)
  const storedOffset = yield* storedLocatorOffset(ctx, key)
  if (storedOffset !== undefined) {
    const storedPool = yield* rawPoolAtOffset(ctx, storedOffset)
    if (storedPool && rawPoolMatches(storedPool, poolAddress)) {
      const resolved: ResolvedPoolLocator = { offset: storedOffset, rawPool: storedPool }
      return resolved
    }
    if (ctx.poolLocatorStore) {
      const store = ctx.poolLocatorStore
      yield* Effect.tryPromise(() => store.delete(key)).pipe(Effect.ignore)
    }
  }

  const rawPools = yield* clientCall(() => ctx.client.getRawPools(false))
  const offset = rawPools.findIndex((pool) => rawPoolMatches(pool, poolAddress))
  if (offset < 0) return undefined
  const verifiedPool = yield* rawPoolAtOffset(ctx, offset)
  if (!verifiedPool || !rawPoolMatches(verifiedPool, poolAddress)) {
    throw new Error(
      `Sugar pool ${poolAddress} could not be verified at its discovered offset`,
    )
  }
  if (ctx.poolLocatorStore) {
    const store = ctx.poolLocatorStore
    yield* Effect.tryPromise(() => store.set(key, { offset })).pipe(Effect.ignore)
  }
  const resolved: ResolvedPoolLocator = { offset, rawPool: verifiedPool }
  return resolved
})

export const resolvePoolLocator = Effect.fn('Sugar.Pools.resolvePoolLocator')(function* (
  ctx: SugarContext,
  poolAddress: Address,
) {
  return yield* Cache.get(ctx.resolvedPoolLocators, addressKey(poolAddress))
})

/** Lookup used by the per-client locator cache; keys are lowercased addresses. */
export function makeResolvedPoolLocatorCache(getCtx: () => SugarContext) {
  return makeReadCache(
    (cacheKey: string) => Effect.suspend(() => lookupPoolLocator(getCtx(), normalizeAddress(cacheKey))),
    4_096,
    0,
  )
}

function epochMaps(pools: LiquidityPool[], tokens: Token[], prices: Price[]) {
  return {
    pools: new Map(pools.map((pool) => [addressKey(pool.lp), pool])),
    tokens: new Map(tokens.map((token) => [addressKey(token.tokenAddress), token])),
    prices: new Map(prices.map((price) => [addressKey(price.token.tokenAddress), price])),
  }
}

export const getPoolEpochs = Effect.fn('Sugar.Pools.getPoolEpochs')(function* (
  ctx: SugarContext,
  lp: Address | string,
  offset = 0,
  limit = 10,
) {
  const [tokens, pools, raw] = yield* Effect.all([
    clientCall(() => ctx.client.getAllTokens()),
    clientCall(() => ctx.client.getPools()),
    ctx.read<unknown[]>(ctx.settings.sugarRewardsContractAddress, abis.sugarRewards, 'epochsByAddress', [limit, offset, normalizeAddress(lp)]),
  ], { concurrency: 'unbounded' })
  const prices = yield* clientCall(() => ctx.client.getPrices(tokens))
  const maps = epochMaps(pools, tokens, prices)
  return raw.map((epoch) => epochFromTuple(epoch, maps.pools, maps.tokens, maps.prices))
})

export const getLatestPoolEpochs = Effect.fn('Sugar.Pools.getLatestPoolEpochs')(function* (
  ctx: SugarContext,
) {
  const rawEpochs = yield* paginate(ctx, 'epochsLatest', (limit, offset) => ctx.readTask<unknown[]>(ctx.settings.sugarRewardsContractAddress, abis.sugarRewards, 'epochsLatest', [limit, offset]))
  if (rawEpochs.length === 0) return []
  const tokens = yield* clientCall(() => ctx.client.getAllTokens())
  const poolAddresses = new Set(rawEpochs.map((epoch) => addressKey(String(tupleValues(epoch)[1]))))
  const allRawPools = yield* clientCall(() => ctx.client.getRawPools(false))
  const rawPools = allRawPools.filter((pool) => poolAddresses.has(addressKey(String(tupleValues(pool)[0]))))
  const needed = new Set<string>([addressKey(ctx.settings.stableTokenAddress), ctx.settings.nativeTokenSymbol])
  rawPools.forEach((pool) => {
    const p = tupleValues(pool)
    ;[p[7], p[10], p[20]].forEach((address) => needed.add(addressKey(String(address))))
  })
  rawEpochs.forEach((epoch) => {
    const e = tupleValues(epoch)
    ;[...tupleValues(e[4]), ...tupleValues(e[5])].forEach((reward) => needed.add(addressKey(String(tupleValues(reward)[0]))))
  })
  const priceTokens = tokens.filter((token) => needed.has(addressKey(token.tokenAddress)) && (token.wrappedTokenAddress || token.listed || token.emerging))
  const prices = yield* clientCall(() => ctx.client.getPrices(priceTokens))
  const pools = preparePools(rawPools, tokens, prices, ctx.settings)
  const maps = epochMaps(pools, tokens, prices)
  return rawEpochs.map((epoch) => epochFromTuple(epoch, maps.pools, maps.tokens, maps.prices))
})
