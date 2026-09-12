import * as Cache from 'effect/Cache'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type { SugarRpcError } from '../errors'
import type { SugarClientCaches } from '../types'
import type { SugarContext } from './context'

/** Successes expire after the configured TTL; failures are never retained. */
const successOnly = (ttlMs: number) => <A>(exit: Exit.Exit<A, SugarRpcError>) =>
  Exit.isSuccess(exit) ? Duration.millis(ttlMs) : Duration.zero

/**
 * Keyed dedupe cache for chain reads owned by a single client: concurrent
 * lookups of a missing key share one in-flight read and failed lookups are
 * never retained.
 */
export function makeReadCache<Key, A>(
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
export function makeSharedReadCache<Key, A>(
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
