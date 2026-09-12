import * as Cache from 'effect/Cache'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { SugarClient } from './client'
import { fuzzyScore } from './fuzzy'
import { addressKey } from './helpers'
import type { Token } from './types'

/**
 * The live Aerodrome/Velodrome token catalog, read straight from the chain's
 * Sugar contract (`tokens()` paginated scan) instead of any hardcoded list.
 * `getAllTokens(true)` keeps the native gas token plus every token flagged
 * `listed` on-chain, which is Aerodrome's own whitelist, so unlisted scam
 * clones never reach a picker built on this module.
 *
 * One process-wide cache keyed by chain id. Successes live an hour (symbols,
 * decimals, and addresses barely move); failed scans get a zero TTL so the
 * next call retries instead of failing forever.
 */

export type TokenChoice = {
  token: Token
  /** Symbol, e.g. "USDC" or "ETH". */
  title: string
  /** Context rendered next to the symbol: address, decimals, flags. */
  description: string
}

let catalogClientFactory = (chainId: number): SugarClient => new SugarClient(chainId)

/**
 * Let an embedding app (the TUI) supply its shared cache store and RPC
 * tuning, so the catalog scan dedupes against token reads the app already
 * warmed instead of paying its own full pagination sweep.
 */
export function setTokenCatalogClientFactory(factory: (chainId: number) => SugarClient): void {
  catalogClientFactory = factory
}

const catalogs = Effect.runSync(
  Cache.makeWith((chainId: number) =>
    Effect.tryPromise({
      // The on-chain scan can return the same contract several times (one
      // row per pool listing); pickers must see each token exactly once.
      try: () => catalogClientFactory(chainId).getAllTokens(true).then(dedupeTokens),
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
    }), {
    capacity: 16,
    timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.hours(1) : Duration.zero,
  }),
)

export const loadTokenCatalog = Effect.fn('Sugar.TokenCatalog.load')(function* (chainId: number) {
  return yield* Cache.get(catalogs, chainId)
})

function shortAddress(address: string): string {
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

export function describeToken(token: Token): string {
  const native = token.tokenAddress === token.symbol
  const address = native ? undefined : shortAddress(token.tokenAddress)
  const wrapped = native && token.wrappedTokenAddress ? `wrapped ${shortAddress(token.wrappedTokenAddress)}` : undefined
  const tags = [
    native ? 'native' : undefined,
    token.emerging ? 'emerging' : undefined,
    `${token.decimals} decimals`,
    wrapped,
    address,
  ].filter((tag): tag is string => tag !== undefined)
  return tags.join(' · ')
}

export function toTokenChoice(token: Token): TokenChoice {
  return { token, title: token.symbol, description: describeToken(token) }
}

/** Collapse duplicate contracts; first occurrence wins. */
export function dedupeTokens(tokens: Token[]): Token[] {
  const seen = new Set<string>()
  const unique: Token[] = []
  for (const token of tokens) {
    const key = addressKey(token.tokenAddress)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(token)
  }
  return unique
}

/**
 * Rank catalog entries against a query for pickers and suggestions.
 * Exact symbols win outright, then addresses (full or prefix), then fuzzy
 * matches over "SYMBOL 0xabc…def"; ties break toward shorter symbols so
 * "WETH" edges wrapped variants with longer names.
 */
export function searchTokens(tokens: Token[], query: string, limit = 12): Token[] {
  if (tokens.length === 0) return []
  const text = query.trim()
  if (text === '') return dedupeTokens(tokens).slice(0, limit)
  const lower = text.toLowerCase()
  if (lower.startsWith('0x')) {
    return dedupeTokens(tokens.filter((token) => token.tokenAddress.toLowerCase().startsWith(lower))).slice(0, limit)
  }
  const scored: Array<{ token: Token; score: number }> = []
  for (const token of dedupeTokens(tokens)) {
    const haystack = `${token.symbol} ${shortAddress(token.tokenAddress)}`
    const score = token.symbol.toLowerCase() === lower ? -1 : fuzzyScore(text, haystack)
    if (score !== undefined) scored.push({ token, score })
  }
  return scored
    .sort((left, right) =>
      left.score - right.score
      || left.token.symbol.length - right.token.symbol.length
      || left.token.symbol.localeCompare(right.token.symbol))
    .slice(0, limit)
    .map((entry) => entry.token)
}

/**
 * Resolve a user-typed reference against the catalog without interaction:
 * an exact (case-insensitive) symbol or full address returns that single
 * token; anything else returns every candidate worth disambiguating.
 */
export function resolveTokenReference(tokens: Token[], reference: string) {
  const text = reference.trim()
  if (text === '') return { exact: undefined, candidates: [] }
  const lower = text.toLowerCase()
  const byAddress = tokens.find((token) => token.tokenAddress.toLowerCase() === lower)
  if (byAddress) return { exact: byAddress, candidates: [byAddress] }
  const bySymbol = dedupeTokens(tokens.filter((token) => token.symbol.toLowerCase() === lower))
  if (bySymbol.length === 1) return { exact: bySymbol[0], candidates: bySymbol }
  return { exact: undefined, candidates: searchTokens(tokens, text) }
}
