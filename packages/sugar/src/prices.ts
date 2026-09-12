// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import type { Address } from 'viem'
import { abis } from './abis'
import { addressKey, chunk, tokenContractAddress } from './helpers'
import type { SugarContext } from './internal/context'
import { nativeToken, preparePrices, tokenFromTuple } from './models'
import { ADDRESS_ZERO, type Token } from './types'

export function getPriceRequestTokens(tokens: Token[]): Token[] {
  return [...new Map(tokens.filter((token) => token.wrappedTokenAddress || token.listed || token.emerging).map((token) => [token.tokenAddress, token])).values()]
}

export function getPriceConnectors(ctx: SugarContext): Address[] {
  return [...new Set([...ctx.settings.connectorTokenAddresses, ctx.settings.stableTokenAddress])]
}

export const getPrices = Effect.fn('Sugar.Prices.getPrices')(function* (
  ctx: SugarContext,
  tokens: Token[],
) {
  if (tokens.length === 0) return []
  if (tokens.some((token) => token.chainId !== ctx.settings.chainId)) throw new Error('Price token chain does not match client chain')
  let stable = tokens.find((token) => addressKey(token.tokenAddress) === addressKey(ctx.settings.stableTokenAddress))
  if (!stable) {
    const raw = yield* ctx.read<unknown[]>(ctx.settings.sugarContractAddress, abis.sugar, 'tokens', [1n, 0n, ADDRESS_ZERO, [ctx.settings.stableTokenAddress]])
    stable = raw.map((item) => tokenFromTuple(item, ctx.settings)).find((token) => addressKey(token.tokenAddress) === addressKey(ctx.settings.stableTokenAddress))
  }
  if (!stable) throw new Error('Stable pricing anchor is unavailable')
  const requestTokens = ctx.client.getPriceRequestTokens([...tokens, nativeToken(ctx.settings), stable])
  const rateMap = new Map<string, bigint>()
  const now = Date.now()
  const staleTokens = requestTokens.filter((token) => {
    const cached = ctx.caches.priceRateCache.get(addressKey(token.tokenAddress))
    if (cached && cached.expiresAt > now) {
      rateMap.set(token.tokenAddress, cached.rate)
      return false
    }
    return true
  })
  if (staleTokens.length > 0) {
    const batches = chunk(staleTokens, ctx.settings.priceBatchSize)
    const connectors = ctx.client.getPriceConnectors()
    const results = yield* ctx.rpc.forEachRead(
      'getManyRatesToEthWithCustomConnectors',
      batches,
      (batch) =>
        // SAFETY: viem cannot statically type a dynamic read over a JSON ABI;
        // the oracle returns one rate per requested token.
        ctx.publicClient.readContract({
          address: ctx.settings.priceOracleContractAddress,
          abi: abis.priceOracle,
          functionName: 'getManyRatesToEthWithCustomConnectors',
          args: [batch.map(tokenContractAddress), false, connectors, ctx.settings.priceThresholdFilter],
        }) as Promise<bigint[]>,
      ctx.settings.requestConcurrency,
    )
    const expiresAt = Date.now() + ctx.settings.pricingCacheTimeoutSeconds * 1_000
    batches.forEach((batch, index) => batch.forEach((token, tokenIndex) => {
      const rate = results[index]?.[tokenIndex]
      if (rate === undefined) throw new Error('Price oracle returned fewer rates than requested')
      rateMap.set(token.tokenAddress, rate)
      ctx.caches.priceRateCache.set(addressKey(token.tokenAddress), { expiresAt, rate })
    }))
  }
  const requested = new Set(tokens.map((token) => addressKey(token.tokenAddress)))
  return preparePrices(requestTokens, requestTokens.map((token) => rateMap.get(token.tokenAddress) ?? 0n), ctx.settings)
    .filter((price) => requested.has(addressKey(price.token.tokenAddress)) && Number.isFinite(price.price) && price.price > 0)
})
