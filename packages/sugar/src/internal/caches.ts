import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import type { Address } from 'viem'
import type { SugarRpcError } from '../errors'
import { normalizeAddress } from '../helpers'
import type {
  LiquidityPool,
  LiquidityPoolForSwap,
  SugarClientCaches,
  Token,
  VeNftContracts,
} from '../types'
import type { ResolvedPoolLocator, SugarContext } from './context'

/** Successes expire after the configured TTL; failures are never retained. */
const successOnly = (ttlMs: number) => <A>(exit: Exit.Exit<A, SugarRpcError>) =>
  Exit.isSuccess(exit) ? Duration.millis(ttlMs) : Duration.zero

/**
 * Keyed dedupe cache for chain reads owned by a single client: concurrent
 * lookups of a missing key share one in-flight read and failed lookups are
 * never retained.
 */
function makeReadCache<Key, A>(
  lookup: (key: Key) => Effect.Effect<A, SugarRpcError>,
  capacity = 16,
  ttlMs = 120_000,
): Effect.Effect<Cache.Cache<Key, A, SugarRpcError>> {
  return Cache.makeWith(lookup, { capacity, timeToLive: successOnly(ttlMs) })
}

/**
 * Keyed dedupe cache shared across SugarClient instances through a cache
 * store entry. The lookup is late-bound to the client currently driving the
 * read (`activeContext`), so a client with a broken transport can never
 * poison the store for healthy clients: its failed lookup is not retained,
 * and the next client retries with its own transport.
 */
function makeSharedReadCache<Key, A>(
  caches: SugarClientCaches,
  lookup: (ctx: SugarContext, key: Key) => Effect.Effect<A, SugarRpcError>,
  capacity = 16,
): Effect.Effect<Cache.Cache<Key, A, SugarRpcError>> {
  return Cache.makeWith(
    (key: Key) => Effect.suspend(() => {
      const ctx = caches.activeContext
      if (!ctx) return Effect.die(new Error('shared Sugar cache lookup without an active client context'))
      return lookup(ctx, key)
    }),
    { capacity, timeToLive: successOnly(caches.ttlMs ?? 120_000) },
  )
}

export type SharedLookup<Key, A> = (active: SugarContext, key: Key) => Effect.Effect<A, SugarRpcError>
export type ClientLookup<Key, A> = (ctx: SugarContext, key: Key) => Effect.Effect<A, SugarRpcError>

/** Lookups the domain modules own; the caches layer only wires them to handles. */
export interface SugarCacheLookups {
  readonly tokens: SharedLookup<'catalog', Token[]>
  readonly rawPools: SharedLookup<boolean, unknown[]>
  readonly pools: SharedLookup<boolean, LiquidityPool[] | LiquidityPoolForSwap[]>
  readonly permit2Address: SharedLookup<'permit2', Address>
  readonly veNftContracts: ClientLookup<'contracts', VeNftContracts>
  readonly poolLocator: ClientLookup<Address, ResolvedPoolLocator | undefined>
}

/** Resolved cache handles for one client: shared ones live on the store entry, per-client ones are fresh. */
export interface SugarCacheHandles {
  readonly tokens: Cache.Cache<'catalog', Token[], SugarRpcError>
  readonly rawPools: Cache.Cache<boolean, unknown[], SugarRpcError>
  readonly pools: Cache.Cache<boolean, LiquidityPool[] | LiquidityPoolForSwap[], SugarRpcError>
  readonly permit2Address: Cache.Cache<'permit2', Address, SugarRpcError>
  readonly veNftContracts: Cache.Cache<'contracts', VeNftContracts, SugarRpcError>
  readonly resolvedPoolLocators: Cache.Cache<string, ResolvedPoolLocator | undefined, SugarRpcError>
}

export class SugarCaches extends Context.Service<SugarCaches, SugarCacheHandles>()('@beegreat/sugar/Caches') {}

export function sugarCachesLayer(
  entry: SugarClientCaches,
  lookups: SugarCacheLookups,
  getCtx: () => SugarContext,
): Layer.Layer<SugarCaches> {
  return Layer.effect(SugarCaches, Effect.gen(function* () {
    entry.tokenCache ??= yield* makeSharedReadCache(entry, lookups.tokens)
    entry.rawPoolCache ??= yield* makeSharedReadCache(entry, lookups.rawPools)
    entry.poolCache ??= yield* makeSharedReadCache(entry, lookups.pools)
    entry.permit2AddressCache ??= yield* makeSharedReadCache(entry, lookups.permit2Address)
    const veNftContracts = yield* makeReadCache((key: 'contracts') => Effect.suspend(() => lookups.veNftContracts(getCtx(), key)))
    const resolvedPoolLocators = yield* makeReadCache(
      (cacheKey: string) => Effect.suspend(() => lookups.poolLocator(getCtx(), normalizeAddress(cacheKey))),
      4_096,
      0,
    )
    return SugarCaches.of({
      tokens: entry.tokenCache,
      rawPools: entry.rawPoolCache,
      pools: entry.poolCache,
      permit2Address: entry.permit2AddressCache,
      veNftContracts,
      resolvedPoolLocators,
    })
  }))
}

/** Invalidate mutable reads after confirmation or an explicit refresh. */
export const invalidateSugarCaches = Effect.fn('Sugar.Cache.invalidate')(function* (caches: SugarClientCaches) {
  caches.poolCountCache = undefined
  caches.poolCountExpiresAt = undefined
  caches.priceRateCache.clear()
  if (caches.tokenCache) yield* Cache.invalidateAll(caches.tokenCache)
  if (caches.rawPoolCache) yield* Cache.invalidateAll(caches.rawPoolCache)
  if (caches.poolCache) yield* Cache.invalidateAll(caches.poolCache)
})

export function sharedCacheGet<Key, A>(
  ctx: SugarContext,
  cache: Cache.Cache<Key, A, SugarRpcError>,
  key: Key,
): Effect.Effect<A, SugarRpcError> {
  return Effect.suspend(() => {
    ctx.caches.activeContext = ctx
    return Cache.get(cache, key)
  })
}
