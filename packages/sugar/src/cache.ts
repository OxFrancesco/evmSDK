import type { SugarCacheStore, SugarClientCaches } from './types'
import { invalidateSugarCaches } from './internal/caches'
import { runSugar } from './internal/interop'

export type SugarCacheStoreOptions = {
  /** How long one chain's caches stay shared before a fresh scan. */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 120_000

function freshCaches(): SugarClientCaches {
  return { priceRateCache: new Map() }
}

/**
 * Create a store that shares token and pool caches across SugarClient
 * instances for the same chain and RPC. Swap amounts always come from live
 * quoter calls, so a short TTL only delays seeing brand-new pools or tokens.
 */
export function createSugarCacheStore(
  options: SugarCacheStoreOptions = {},
): SugarCacheStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('cacheStore.ttlMs must be a positive number')
  }
  const entries = new Map<
    string,
    SugarClientCaches
  >()
  return {
    cachesFor(chainId, rpcUrl, settingsKey = '') {
      const key = `${chainId}:${rpcUrl}:${settingsKey}`
      const entry = entries.get(key)
      if (entry) return entry
      if (entries.size >= 64) return { ...freshCaches(), ttlMs }
      const caches = { ...freshCaches(), ttlMs }
      entries.set(key, caches)
      return caches
    },
    async invalidate() {
      await Promise.all([...entries.values()].map((caches) => runSugar(invalidateSugarCaches(caches))))
    },
  }
}
