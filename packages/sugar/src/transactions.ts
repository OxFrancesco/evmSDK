// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import { concatHex, pad, type Address, type Hex } from 'viem'
import { abis } from './abis'
import {
  addressKey,
  applySlippage,
  futureTimestamp,
  nearestTick,
  normalizeAddress,
  priceToTick,
  sqrtRatioX96FromPrice,
  tokenContractAddress,
  tupleValues,
} from './helpers'
import { makeSharedReadCache, sharedCacheGet } from './internal/caches'
import type { SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { createPoolSpec, validateDepositQuote } from './models'
import { setupPlanner } from './planner'
import {
  ADDRESS_ZERO,
  MAX_UINT128,
  type DepositQuote,
  type LiquidityPool,
  type Position,
  type Quote,
  type Token,
  type UnsignedTransaction,
  type Withdrawal,
} from './types'

const MAX_UINT160 = (1n << 160n) - 1n
const PERMIT2_APPROVAL_MINUTES = 30
const PERMIT2_VALIDITY_BUFFER_MINUTES = 10

export const getBridgeFee = Effect.fn('Sugar.Transactions.getBridgeFee')(function* (
  ctx: SugarContext,
  domain: number,
) {
  return yield* ctx.read<bigint>(ctx.settings.bridgeContractAddress, abis.bridgeGetFee, 'quoteGasPayment', [domain])
})

export const checkTokenAllowance = Effect.fn('Sugar.Transactions.checkTokenAllowance')(function* (
  ctx: SugarContext,
  token: Token,
  spender: Address,
) {
  return yield* ctx.read<bigint>(tokenContractAddress(token), abis.erc20, 'allowance', [ctx.signer(), spender])
})

export const setTokenAllowance = Effect.fn('Sugar.Transactions.setTokenAllowance')(function* (
  ctx: SugarContext,
  token: Token,
  spender: Address,
  amount: bigint,
) {
  return yield* approveAddressIfNeeded(ctx, tokenContractAddress(token), spender, amount)
})

export const revokeTokenAllowance = Effect.fn('Sugar.Transactions.revokeTokenAllowance')(function* (
  ctx: SugarContext,
  token: Token,
  spender: Address,
) {
  const tokenAddress = tokenContractAddress(token)
  const allowance = yield* ctx.read<bigint>(
    tokenAddress,
    abis.erc20,
    'allowance',
    [ctx.signer(), spender],
  )
  return allowance === 0n
    ? []
    : [ctx.tx(tokenAddress, ctx.encode(abis.erc20, 'approve', [spender, 0n]))]
})

export const revokePermit2Allowance = Effect.fn('Sugar.Transactions.revokePermit2Allowance')(function* (
  ctx: SugarContext,
  token: Token,
) {
  if (token.wrappedTokenAddress) return []
  const tokenAddress = tokenContractAddress(token)
  const permit2 = yield* getPermit2Address(ctx)
  const [tokenAllowance, permit2Allowance] = yield* Effect.all([
    ctx.read<bigint>(tokenAddress, abis.erc20, 'allowance', [ctx.signer(), permit2]),
    ctx.read<readonly [bigint, bigint, bigint]>(permit2, abis.permit2, 'allowance', [
      ctx.signer(), tokenAddress, ctx.settings.swapperContractAddress,
    ]),
  ], { concurrency: 'unbounded' })
  const transactions: UnsignedTransaction[] = []
  if (tokenAllowance > 0n) {
    transactions.push(
      ctx.tx(tokenAddress, ctx.encode(abis.erc20, 'approve', [permit2, 0n])),
    )
  }
  // Permit2 stores an expiration even after amount is cleared (an input of
  // zero may be normalized to the current block timestamp). Only a non-zero
  // spendable amount needs another revocation transaction.
  if (permit2Allowance[0] > 0n) {
    transactions.push(
      ctx.tx(permit2, ctx.encode(abis.permit2, 'approve', [
        tokenAddress,
        ctx.settings.swapperContractAddress,
        0n,
        0,
      ])),
    )
  }
  return transactions
})

export const bridge = Effect.fn('Sugar.Transactions.bridge')(function* (
  ctx: SugarContext,
  fromToken: Token,
  amount: bigint,
  domain: number,
) {
  const approval = yield* clientCall(() => ctx.client.setTokenAllowance(fromToken, ctx.settings.bridgeContractAddress, amount))
  const bridgeFee = yield* clientCall(() => ctx.client.getBridgeFee(domain))
  const transfer = ctx.tx(ctx.settings.bridgeContractAddress, ctx.encode(abis.bridgeTransferRemote, 'transferRemote', [
    domain, pad(ctx.signer(), { size: 32 }), amount,
  ]), bridgeFee)
  return [approval, transfer].filter((tx): tx is UnsignedTransaction => tx !== undefined)
})

export const swap = Effect.fn('Sugar.Transactions.swap')(function* (
  ctx: SugarContext,
  fromToken: Token,
  toToken: Token,
  amount: bigint,
  slippage?: number,
) {
  const quote = yield* clientCall(() => ctx.client.getQuote(fromToken, toToken, amount))
  if (!quote) throw new Error('No quotes found')
  return yield* clientCall(() => ctx.client.swapFromQuote(quote, slippage))
})

export const swapFromQuote = Effect.fn('Sugar.Transactions.swapFromQuote')(function* (
  ctx: SugarContext,
  quote: Quote,
  slippage?: number,
) {
  const plan = setupPlanner(quote, slippage ?? ctx.settings.swapSlippage, ctx.signer(), ctx.settings.swapperContractAddress, {
    newFactory: ctx.settings.slipstreamFactoryAddress,
    oldFactory: ctx.settings.oldSlipstreamFactoryAddress,
  })
  const main = ctx.tx(ctx.settings.swapperContractAddress, ctx.encode(abis.swapper, 'execute', [plan.commands, plan.inputs]), quote.input.fromToken.wrappedTokenAddress ? quote.input.amountIn : 0n)
  if (quote.input.fromToken.wrappedTokenAddress) return [main]
  const approvals = yield* permit2Approvals(ctx, quote.input.fromToken, quote.input.amountIn)
  return [...approvals, main]
})

export const swapBasketFromQuotes = Effect.fn('Sugar.Transactions.swapBasketFromQuotes')(function* (
  ctx: SugarContext,
  quotes: Quote[],
  slippage: number,
) {
  if (quotes.length === 0) return []
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) throw new Error('Invalid basket slippage')
  const totals = new Map<string, { token: Token; amount: bigint }>()
  const plans = quotes.map((quote) => {
    if (quote.input.fromToken.wrappedTokenAddress) throw new Error('Basket inputs must be ERC-20 tokens')
    const key = addressKey(tokenContractAddress(quote.input.fromToken))
    const previous = totals.get(key)
    totals.set(key, { token: quote.input.fromToken, amount: (previous?.amount ?? 0n) + quote.input.amountIn })
    return setupPlanner(quote, slippage, ctx.signer(), ctx.settings.swapperContractAddress, {
      newFactory: ctx.settings.slipstreamFactoryAddress,
      oldFactory: ctx.settings.oldSlipstreamFactoryAddress,
    })
  })
  const approvals: UnsignedTransaction[] = []
  for (const { token, amount } of totals.values()) {
    approvals.push(...(yield* permit2Approvals(ctx, token, amount)))
  }
  return [...approvals, ctx.tx(ctx.settings.swapperContractAddress, ctx.encode(abis.swapper, 'execute', [
    concatHex(plans.map((plan) => plan.commands)), plans.flatMap((plan) => plan.inputs),
  ]))]
})

const getPermit2Address = Effect.fn('Sugar.Transactions.getPermit2Address')(function* (
  ctx: SugarContext,
) {
  const cache = ctx.caches.permit2AddressCache ??= yield* makeSharedReadCache(ctx.caches, (active, _key: 'permit2') =>
    active.read<Address>(active.settings.swapperContractAddress, abis.swapper, 'PERMIT2'),
  )
  return yield* sharedCacheGet(ctx, cache, 'permit2')
})

const permit2Approvals = Effect.fn('Sugar.Transactions.permit2Approvals')(function* (
  ctx: SugarContext,
  token: Token,
  amount: bigint,
) {
  if (amount > MAX_UINT160) throw new RangeError('Permit2 swap amount exceeds uint160')
  const tokenAddress = tokenContractAddress(token)
  const spender = ctx.settings.swapperContractAddress
  const permit2 = yield* getPermit2Address(ctx)
  const [tokenAllowance, permit2Allowance] = yield* Effect.all([
    ctx.read<bigint>(tokenAddress, abis.erc20, 'allowance', [ctx.signer(), permit2]),
    ctx.read<readonly [bigint, bigint, bigint]>(permit2, abis.permit2, 'allowance', [
      ctx.signer(), tokenAddress, spender,
    ]),
  ], { concurrency: 'unbounded' })
  const tokenApproval = tokenAllowance >= amount
    ? undefined
    : ctx.tx(tokenAddress, ctx.encode(abis.erc20, 'approve', [permit2, amount]))
  const [permit2Amount, permit2Expiration] = permit2Allowance
  const permit2Approval = permit2Amount >= amount &&
    permit2Expiration > futureTimestamp(PERMIT2_VALIDITY_BUFFER_MINUTES)
    ? undefined
    : ctx.tx(permit2, ctx.encode(abis.permit2, 'approve', [
      tokenAddress, spender, amount, futureTimestamp(PERMIT2_APPROVAL_MINUTES),
    ]))
  return [tokenApproval, permit2Approval].filter(
    (transaction): transaction is UnsignedTransaction => transaction !== undefined,
  )
})

export const poolSpec = Effect.fn('Sugar.Transactions.poolSpec')(function* (
  ctx: SugarContext,
  token0: Token,
  token1: Token,
  options: { tickSpacing?: number; stable?: boolean },
) {
  const basicFactoryAddress = options.stable === undefined
    ? undefined
    : yield* ctx.read<Address>(ctx.settings.routerContractAddress, abis.router, 'defaultFactory')
  return createPoolSpec(ctx.settings, token0, token1, { ...options, basicFactoryAddress })
})

export const quoteBasicDeposit = Effect.fn('Sugar.Transactions.quoteBasicDeposit')(function* (
  ctx: SugarContext,
  pool: LiquidityPool,
  amounts: { amountToken0?: bigint; amountToken1?: bigint },
) {
  if (pool.isCl) throw new Error('quoteBasicDeposit requires a basic pool')
  if (pool.lp === ADDRESS_ZERO) {
    if (amounts.amountToken0 === undefined || amounts.amountToken1 === undefined) throw new Error('new basic pool requires both amounts')
    return validateDepositQuote({ pool, amountToken0: amounts.amountToken0, amountToken1: amounts.amountToken1, sqrtPriceX96: 0n })
  }
  if ((amounts.amountToken0 === undefined) === (amounts.amountToken1 === undefined)) throw new Error('supply exactly one amount')
  const result = yield* ctx.read<unknown>(ctx.settings.routerContractAddress, abis.router, 'quoteAddLiquidity', [
    normalizeAddress(pool.token0.tokenAddress), normalizeAddress(pool.token1.tokenAddress), pool.isStable, pool.factory,
    amounts.amountToken0 ?? MAX_UINT128, amounts.amountToken1 ?? MAX_UINT128,
  ])
  const [amountToken0, amountToken1] = tupleValues(result)
  // SAFETY: the router's quoteAddLiquidity tuple leads with two uint256
  // amounts, which viem decodes as bigints.
  return validateDepositQuote({ pool, amountToken0: BigInt(amountToken0 as bigint), amountToken1: BigInt(amountToken1 as bigint), sqrtPriceX96: 0n })
})

export const quoteConcentratedDeposit = Effect.fn('Sugar.Transactions.quoteConcentratedDeposit')(function* (
  ctx: SugarContext,
  pool: LiquidityPool,
  options: {
    priceLower?: number; priceUpper?: number; tickLower?: number; tickUpper?: number
    amountToken0?: bigint; amountToken1?: bigint; initialPrice?: number
  },
) {
  if (!pool.isCl) throw new Error('quoteConcentratedDeposit requires a CL pool')
  if ((options.amountToken0 === undefined) === (options.amountToken1 === undefined)) throw new Error('supply exactly one amount')
  const hasPrice = options.priceLower !== undefined || options.priceUpper !== undefined
  const hasTick = options.tickLower !== undefined || options.tickUpper !== undefined
  if (hasPrice === hasTick) throw new Error('supply price range XOR tick range')
  let tickLower: number
  let tickUpper: number
  if (hasTick) {
    if (options.tickLower === undefined || options.tickUpper === undefined) throw new Error('supply both tick bounds')
    tickLower = options.tickLower
    tickUpper = options.tickUpper
  } else {
    if (options.priceLower === undefined || options.priceUpper === undefined) throw new Error('supply both price bounds')
    tickLower = nearestTick(priceToTick(options.priceLower, pool.token0.decimals, pool.token1.decimals), pool.type)
    tickUpper = nearestTick(priceToTick(options.priceUpper, pool.token0.decimals, pool.token1.decimals), pool.type)
  }
  let sqrtRatio = pool.sqrtRatio
  let sqrtPriceX96 = 0n
  if (sqrtRatio === 0n) {
    if (options.initialPrice === undefined) throw new Error('uninitialized pool requires initialPrice')
    sqrtRatio = sqrtRatioX96FromPrice(options.initialPrice, pool.token0.decimals, pool.token1.decimals)
    sqrtPriceX96 = sqrtRatio
  } else if (options.initialPrice !== undefined) throw new Error('initialPrice only applies to uninitialized pools')
  if (options.amountToken0 !== undefined) {
    const amountToken1 = yield* ctx.read<bigint>(ctx.settings.slipstreamContractAddress, abis.slipstream, 'estimateAmount1', [options.amountToken0, pool.lp, sqrtRatio, tickLower, tickUpper])
    return validateDepositQuote({ pool, amountToken0: options.amountToken0, amountToken1, tickLower, tickUpper, sqrtPriceX96 })
  }
  const amountToken0 = yield* ctx.read<bigint>(ctx.settings.slipstreamContractAddress, abis.slipstream, 'estimateAmount0', [options.amountToken1!, pool.lp, sqrtRatio, tickLower, tickUpper])
  return validateDepositQuote({ pool, amountToken0, amountToken1: options.amountToken1!, tickLower, tickUpper, sqrtPriceX96 })
})

/** A pool leg is native only when its token explicitly represents native currency. */
function isNativeLeg(ctx: SugarContext, token: Token): boolean {
  return token.wrappedTokenAddress !== undefined && addressKey(token.wrappedTokenAddress) === addressKey(ctx.settings.wrappedNativeTokenAddress)
}

const collectApprovals = Effect.fn('Sugar.Transactions.collectApprovals')(function* (
  ctx: SugarContext,
  pool: LiquidityPool,
  target: Address,
  amount0: bigint,
  amount1: bigint,
) {
  const native0 = isNativeLeg(ctx, pool.token0)
  const native1 = isNativeLeg(ctx, pool.token1)
  const approvals: UnsignedTransaction[] = []
  if (!native0) {
    const tx = yield* clientCall(() => ctx.client.setTokenAllowance(pool.token0, target, amount0))
    if (tx) approvals.push(tx)
  }
  if (!native1) {
    const tx = yield* clientCall(() => ctx.client.setTokenAllowance(pool.token1, target, amount1))
    if (tx) approvals.push(tx)
  }
  return { approvals, native0, native1 }
})

export const deposit = Effect.fn('Sugar.Transactions.deposit')(function* (
  ctx: SugarContext,
  quote: DepositQuote,
  deadlineMinutes = 30,
  slippage = 0.01,
) {
  validateDepositQuote(quote)
  const { pool, amountToken0: amount0, amountToken1: amount1 } = quote
  const target = pool.isCl ? pool.nfpm : ctx.settings.routerContractAddress
  if (!target || target === ADDRESS_ZERO) throw new Error(`pool ${pool.symbol} has no transaction target`)
  const { approvals, native0, native1 } = yield* collectApprovals(ctx, pool, target, amount0, amount1)
  const deadline = futureTimestamp(deadlineMinutes)
  if (!pool.isCl) {
    const data = native0 || native1
      ? ctx.encode(abis.router, 'addLiquidityETH', [
          native0 ? normalizeAddress(pool.token1.tokenAddress) : normalizeAddress(pool.token0.tokenAddress),
          pool.isStable,
          native0 ? amount1 : amount0,
          applySlippage(native0 ? amount1 : amount0, slippage),
          applySlippage(native0 ? amount0 : amount1, slippage),
          ctx.signer(), deadline,
        ])
      : ctx.encode(abis.router, 'addLiquidity', [
          normalizeAddress(pool.token0.tokenAddress), normalizeAddress(pool.token1.tokenAddress), pool.isStable,
          amount0, amount1, applySlippage(amount0, slippage), applySlippage(amount1, slippage), ctx.signer(), deadline,
        ])
    return [...approvals, ctx.tx(target, data, native0 ? amount0 : native1 ? amount1 : 0n)]
  }
  const mintArgs = [tokenContractAddress(pool.token0), tokenContractAddress(pool.token1), pool.type, quote.tickLower!, quote.tickUpper!, amount0, amount1, applySlippage(amount0, slippage), applySlippage(amount1, slippage), ctx.signer(), deadline, quote.sqrtPriceX96] as const
  const data = native0 || native1
    ? ctx.encode(abis.nfpm, 'multicall', [[ctx.encode(abis.nfpm, 'mint', [mintArgs]), ctx.encode(abis.nfpm, 'refundETH')]])
    : ctx.encode(abis.nfpm, 'mint', [mintArgs])
  return [...approvals, ctx.tx(target, data, native0 ? amount0 : native1 ? amount1 : 0n)]
})

function cleanupCalls(ctx: SugarContext, pool: LiquidityPool, positionId: bigint, unwrapNative: boolean, burn: boolean): Hex[] {
  if (unwrapNative && addressKey(pool.token0.tokenAddress) !== addressKey(ctx.settings.wrappedNativeTokenAddress) && addressKey(pool.token1.tokenAddress) !== addressKey(ctx.settings.wrappedNativeTokenAddress)) throw new Error('unwrapNative: pool has no native leg')
  const recipient = unwrapNative ? ADDRESS_ZERO : ctx.signer()
  const calls = [ctx.encode(abis.nfpm, 'collect', [[positionId, recipient, MAX_UINT128, MAX_UINT128]])]
  if (unwrapNative) {
    const other = addressKey(pool.token0.tokenAddress) === addressKey(ctx.settings.wrappedNativeTokenAddress) ? normalizeAddress(pool.token1.tokenAddress) : normalizeAddress(pool.token0.tokenAddress)
    calls.push(ctx.encode(abis.nfpm, 'unwrapWETH9', [0n, ctx.signer()]), ctx.encode(abis.nfpm, 'sweepToken', [other, 0n, ctx.signer()]))
  }
  if (burn) calls.push(ctx.encode(abis.nfpm, 'burn', [positionId]))
  return calls
}

export const withdraw = Effect.fn('Sugar.Transactions.withdraw')(function* (
  ctx: SugarContext,
  withdrawal: Withdrawal,
  deadlineMinutes = 30,
  slippage = 0.01,
  collect = true,
  unwrapNative = false,
) {
  const { pool } = withdrawal
  if (withdrawal.liquidity <= 0n) throw new Error('liquidity must be positive')
  const amount0Min = applySlippage(withdrawal.amountToken0, slippage)
  const amount1Min = applySlippage(withdrawal.amountToken1, slippage)
  const deadline = futureTimestamp(deadlineMinutes)
  if (!pool.isCl) {
    const approval = yield* approveAddressIfNeeded(ctx, pool.lp, ctx.settings.routerContractAddress, withdrawal.liquidity)
    const native0 = unwrapNative && addressKey(tokenContractAddress(pool.token0)) === addressKey(ctx.settings.wrappedNativeTokenAddress)
    const native1 = unwrapNative && addressKey(tokenContractAddress(pool.token1)) === addressKey(ctx.settings.wrappedNativeTokenAddress)
    const data = native0 || native1
      ? ctx.encode(abis.router, 'removeLiquidityETH', [
          native0 ? normalizeAddress(pool.token1.tokenAddress) : normalizeAddress(pool.token0.tokenAddress), pool.isStable, withdrawal.liquidity,
          native0 ? amount1Min : amount0Min, native0 ? amount0Min : amount1Min, ctx.signer(), deadline,
        ])
      : ctx.encode(abis.router, 'removeLiquidity', [normalizeAddress(pool.token0.tokenAddress), normalizeAddress(pool.token1.tokenAddress), pool.isStable, withdrawal.liquidity, amount0Min, amount1Min, ctx.signer(), deadline])
    const main = ctx.tx(ctx.settings.routerContractAddress, data)
    return [approval, main].filter((tx): tx is UnsignedTransaction => tx !== undefined)
  }
  if (withdrawal.positionId === undefined) throw new Error('CL Withdrawal requires positionId')
  if ((withdrawal.burn || unwrapNative) && !collect) throw new Error('burn / unwrapNative require collect=true')
  const decrease = ctx.encode(abis.nfpm, 'decreaseLiquidity', [[withdrawal.positionId, withdrawal.liquidity, amount0Min, amount1Min, deadline]])
  const data = collect
    ? ctx.encode(abis.nfpm, 'multicall', [[decrease, ...cleanupCalls(ctx, pool, withdrawal.positionId, unwrapNative, withdrawal.burn)]])
    : decrease
  return [ctx.tx(pool.nfpm, data)]
})

export const approveAddressIfNeeded = Effect.fn('Sugar.Transactions.approveAddressIfNeeded')(function* (
  ctx: SugarContext,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  const allowance = yield* ctx.read<bigint>(token, abis.erc20, 'allowance', [ctx.signer(), spender])
  return allowance >= amount ? undefined : ctx.tx(token, ctx.encode(abis.erc20, 'approve', [spender, amount]))
})

function assertPosition(position: Position): void {
  if (position.isAlm) throw new Error('ALM-managed position; not supported')
  if (!position.pool.gauge || position.pool.gauge === ADDRESS_ZERO) throw new Error(`pool ${position.pool.symbol} has no gauge`)
}

export const stake = Effect.fn('Sugar.Transactions.stake')(function* (
  ctx: SugarContext,
  position: Position,
) {
  assertPosition(position)
  const pool = position.pool
  if (!pool.gaugeAlive) throw new Error(`gauge for ${pool.symbol} is not active`)
  const gaugeAbi = pool.isCl ? abis.gaugeCl : abis.gaugeBasic
  if (pool.isCl) {
    if (position.staked > 0n) throw new Error(`CL position #${position.id} is already staked`)
    if (position.liquidity === 0n) throw new Error(`CL position #${position.id} has no liquidity to stake`)
    return [ctx.tx(pool.nfpm, ctx.encode(abis.nfpm, 'approve', [pool.gauge, position.id])), ctx.tx(pool.gauge, ctx.encode(gaugeAbi, 'deposit', [position.id]))]
  }
  if (position.liquidity === 0n) throw new Error(`no LP to stake for ${pool.symbol}`)
  const approval = yield* approveAddressIfNeeded(ctx, pool.lp, pool.gauge, position.liquidity)
  const main = ctx.tx(pool.gauge, ctx.encode(gaugeAbi, 'deposit', [position.liquidity]))
  return [approval, main].filter((tx): tx is UnsignedTransaction => tx !== undefined)
})

export const unstake = Effect.fn('Sugar.Transactions.unstake')(function* (
  ctx: SugarContext,
  position: Position,
  amount?: bigint,
) {
  return yield* Effect.sync(() => {
    assertPosition(position)
    const pool = position.pool
    const gaugeAbi = pool.isCl ? abis.gaugeCl : abis.gaugeBasic
    let value: bigint
    if (pool.isCl) {
      if (position.staked === 0n) throw new Error(`CL position #${position.id} is not staked`)
      value = position.id
    } else {
      value = amount ?? position.staked
      if (value <= 0n) throw new Error('no staked LP to withdraw')
      if (value > position.staked) throw new Error(`unstake amount ${value} > staked ${position.staked}`)
    }
    return [ctx.tx(pool.gauge, ctx.encode(gaugeAbi, 'withdraw', [value]))]
  })
})

export const claimEmissions = Effect.fn('Sugar.Transactions.claimEmissions')(function* (
  ctx: SugarContext,
  position: Position,
) {
  return yield* Effect.sync(() => {
    assertPosition(position)
    const pool = position.pool
    return [ctx.tx(pool.gauge, ctx.encode(pool.isCl ? abis.gaugeCl : abis.gaugeBasic, 'getReward', [pool.isCl ? position.id : ctx.signer()]))]
  })
})

export const claimFees = Effect.fn('Sugar.Transactions.claimFees')(function* (
  ctx: SugarContext,
  position: Position,
  burn = false,
  unwrapNative = false,
) {
  return yield* Effect.sync(() => {
    if (position.isAlm) throw new Error('ALM-managed position; not supported')
    const pool = position.pool
    if (!pool.isCl) return [ctx.tx(pool.lp, ctx.encode(abis.poolBasic, 'claimFees'))]
    if (position.staked > 0n) throw new Error('position is staked; unstake first to claim fees')
    if (burn && position.liquidity > 0n) throw new Error('burn requires liquidity == 0; drain via withdraw first')
    return [ctx.tx(pool.nfpm, ctx.encode(abis.nfpm, 'multicall', [cleanupCalls(ctx, pool, position.id, unwrapNative, burn)]))]
  })
})
