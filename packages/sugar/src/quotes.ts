// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import type { Address } from 'viem'
import { abis } from './abis'
import { addressKey, applySlippage, chunk, findAllPaths, packPath, tokenContractAddress, tokenToNumber, tupleValues } from './helpers'
import type { SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { isTransientRpcFailure, isContractRevert } from './internal/rpc-executor'
import type { LiquidityPoolForSwap, PathHop, Quote, Token } from './types'

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

export function filterPoolsForSwap(ctx: SugarContext, pools: LiquidityPoolForSwap[], fromToken: Token, toToken: Token): LiquidityPoolForSwap[] {
  // Every hop of a valid route connects two tokens from this set (route ends
  // are the swap tokens and intermediates must be vetted connectors), so a
  // pool with a long-tail token on either side can never appear in a path.
  // Dropping them up front keeps the path search off the majority of pools.
  const matches = new Set([...ctx.settings.connectorTokenAddresses, tokenContractAddress(fromToken), tokenContractAddress(toToken)].map(addressKey))
  return pools.filter((pool) => matches.has(addressKey(pool.token0Address)) && matches.has(addressKey(pool.token1Address)))
}

export function getPathsForQuote(
  ctx: SugarContext,
  fromToken: Token,
  toToken: Token,
  pools: LiquidityPoolForSwap[],
  excludedAddresses: Address[] = ctx.settings.excludedTokenAddresses,
): PathHop[][] {
  const excluded = new Set(excludedAddresses.map(addressKey))
  excluded.delete(addressKey(tokenContractAddress(fromToken)))
  excluded.delete(addressKey(tokenContractAddress(toToken)))
  // Multi-hop routes may only pass through vetted connector tokens: an
  // arbitrary intermediate can quote well but revert on transfer (honeypot),
  // failing the whole swap at execution time.
  const allowedIntermediates = new Set(
    [...ctx.settings.connectorTokenAddresses, tokenContractAddress(fromToken), tokenContractAddress(toToken)].map(addressKey),
  )
  const eligible = pools.filter((pool) => [pool.token0Address, pool.token1Address].every((address) => allowedIntermediates.has(addressKey(address)) && !excluded.has(addressKey(address))))
  return findAllPaths(eligible, tokenContractAddress(fromToken), tokenContractAddress(toToken), 3, ctx.settings.quoteMaxPaths).filter((path) =>
    !path.some((hop, index) => {
      if (index === 0) return false
      const hopInput = addressKey(hop.reversed ? hop.pool.token1Address : hop.pool.token0Address)
      return excluded.has(hopInput) || !allowedIntermediates.has(hopInput)
    }),
  )
}

/**
 * Dense chains produce tens of thousands of candidate paths, and quoter
 * simulations are gas-heavy eth_calls that throttle metered RPC plans.
 * Shorter routes carry nearly all real liquidity, so when the candidate
 * set exceeds the budget, keep the shortest paths.
 */
function prioritizeQuotePaths(ctx: SugarContext, paths: PathHop[][]): PathHop[][] {
  const limit = ctx.settings.quoteMaxPaths
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('quoteMaxPaths must be a positive safe integer')
  }
  if (paths.length <= limit) return paths
  return [...paths].sort((a, b) => a.length - b.length).slice(0, limit)
}

type MulticallResponse = Array<{ status: 'success'; result: unknown } | { status: 'failure'; error?: unknown }>

export const getQuote = Effect.fn('Sugar.Quotes.getQuote')(function* (
  ctx: SugarContext,
  fromToken: Token,
  toToken: Token,
  amount: bigint,
  filter?: (quote: Quote) => boolean,
) {
  if (fromToken.chainId !== ctx.settings.chainId || toToken.chainId !== ctx.settings.chainId) throw new Error('Quote tokens must belong to the client chain')
  if (amount <= 0n) throw new Error('Swap amount must be positive')
  const poolsForSwaps = yield* clientCall(() => ctx.client.getPoolsForSwaps())
  const pools = ctx.client.filterPoolsForSwap(poolsForSwaps, fromToken, toToken)
  const paths = prioritizeQuotePaths(ctx, ctx.client.getPathsForQuote(fromToken, toToken, pools))
  const inputs = paths.map((path) => ({
    path,
    encoded: packPath(path, { newFactory: ctx.settings.slipstreamFactoryAddress, oldFactory: ctx.settings.oldSlipstreamFactoryAddress }).encoded,
  }))
  const quoteFromResult = <T>({ path }: (typeof inputs)[number], result: T): Quote => {
    // SAFETY: the quoter returns either a bare uint256 or a tuple that leads
    // with the uint256 amountOut; viem decodes uint256 values as bigints and
    // a mismatch throws here, falling back to the direct-call path.
    const amountOut = Array.isArray(result) || Predicate.isObject(result)
      ? BigInt(tupleValues(result)[0] as bigint)
      : BigInt(result as bigint)
    return {
      input: {
        fromToken,
        toToken,
        path,
        amountIn: amount,
        slipstreamFactoryAddress: ctx.settings.slipstreamFactoryAddress,
        oldSlipstreamFactoryAddress: ctx.settings.oldSlipstreamFactoryAddress,
      },
      amountOut,
    }
  }
  const batches = chunk(inputs, Math.max(1, ctx.settings.quoteBatchSize))
  const deadline = ctx.rpc.deadline('quoteExactInput')
  const multicallBatches = yield* ctx.rpc.forEachReadResult(
    'quoteExactInput.multicall',
    batches,
    async (batch) => {
      // SAFETY: viem cannot statically type a multicall over a JSON ABI; each
      // entry mirrors the quoter's (amountOut, ...) tuple or a failure status.
      const results = await ctx.publicClient.multicall({
        allowFailure: true,
        multicallAddress: MULTICALL3,
        contracts: batch.map(({ encoded }) => ({
          address: ctx.settings.quoterContractAddress,
          abi: abis.quoter,
          functionName: 'quoteExactInput',
          args: [encoded, amount],
        })),
      }) as MulticallResponse
      const transient = results.find(result => result.status === 'failure' && isTransientRpcFailure(result.error))
      if (transient?.status === 'failure') throw transient.error
      return results
    },
    Math.max(1, Math.min(ctx.settings.requestConcurrency, batches.length)),
    deadline,
  )
  const quotes: Quote[] = []
  const fallbackInputs: typeof inputs = []
  multicallBatches.forEach((batchResult, batchIndex) => {
    const batch = batches[batchIndex]
    if (!batch) throw new Error('Quote batch result does not match a request')
    if (!batchResult.ok) {
      fallbackInputs.push(...batch)
      return
    }
    batch.forEach((input, index) => {
      const response = batchResult.value[index]
      if (response?.status !== 'success') {
        if (!response || !isContractRevert(response.error, 'quoteExactInput')) fallbackInputs.push(input)
        return
      }
      try {
        quotes.push(quoteFromResult(input, response.result))
      } catch {
        fallbackInputs.push(input)
      }
    })
  })

  // Some private/test networks do not deploy Multicall3. Preserve the SDK
  // surface with one bounded, fail-fast direct-call fallback phase.
  if (fallbackInputs.length > 0) {
    const directResults = yield* ctx.rpc.forEachReadResult(
      'quoteExactInput.direct',
      fallbackInputs,
      ({ encoded }) => ctx.publicClient.readContract({
        address: ctx.settings.quoterContractAddress,
        abi: abis.quoter,
        functionName: 'quoteExactInput',
        args: [encoded, amount],
      }),
      ctx.settings.requestConcurrency,
      deadline,
    )
    directResults.forEach((result, index) => {
      if (!result.ok) return
      const input = fallbackInputs[index]
      if (!input) throw new Error('Quote result does not match a request')
      try {
        quotes.push(quoteFromResult(input, result.value))
      } catch {
        // A malformed per-path quote is unusable; other paths remain valid.
      }
    })
  }
  const prices = fromToken.listed && toToken.listed
    ? yield* clientCall(() => ctx.client.getPrices([fromToken, toToken])).pipe(Effect.catchCause(() => Effect.succeed([])))
    : []
  const fromPrice = prices.find((price) => addressKey(price.token.tokenAddress) === addressKey(fromToken.tokenAddress))?.price
  const toPrice = prices.find((price) => addressKey(price.token.tokenAddress) === addressKey(toToken.tokenAddress))?.price
  const ceiling = fromPrice && toPrice ? 2 * tokenToNumber(fromToken, amount) * fromPrice / toPrice : undefined
  const valid = quotes.filter((quote) => (!filter || filter(quote))
    && (ceiling === undefined || !Number.isFinite(ceiling) || tokenToNumber(toToken, quote.amountOut) < ceiling))
  const best = valid.reduce<Quote | undefined>(
    (current, quote) => !current || quote.amountOut > current.amountOut ? quote : current,
    undefined,
  )
  if (!best) return undefined
  const minimumCompetitiveOutput = applySlippage(best.amountOut, ctx.settings.swapSlippage)
  return valid.reduce<Quote | undefined>((safest, quote) => {
    if (quote.amountOut < minimumCompetitiveOutput) return safest
    if (!safest || quote.input.path.length < safest.input.path.length) return quote
    if (quote.input.path.length === safest.input.path.length && quote.amountOut > safest.amountOut) return quote
    return safest
  }, undefined)
})
