// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import { formatUnits } from 'viem'
import { stockMarket, stockTrade, rebalanceIndex } from './stocks/trading'
import * as Effect from 'effect/Effect'
import { SugarClient } from './client'
import type { SugarAction, SugarParameters } from './contracts'
import { applySlippage, normalizeAddress, parseTokenUnits, poolTypeLabel, toSugarJson, tokenToNumber } from './helpers'
import { clientCall, runSugar } from './internal/interop'
import { withdrawalFromPosition } from './models'
import { validateSugarRequest } from './index'
import { ADDRESS_ZERO, type Amount, type LiquidityPool, type LiquidityPoolEpoch, type Position, type Quote, type SugarClientOptions, type SugarJson, type Token } from './types'

export type SugarExecutionOptions = SugarClientOptions & {
  clientFactory?: (chainId: number, options: SugarClientOptions) => SugarClient
}

const stringValue = (parameters: SugarParameters, name: string): string | undefined => parameters[name] === undefined ? undefined : String(parameters[name])
const numberValue = (parameters: SugarParameters, name: string): number | undefined => parameters[name] === undefined ? undefined : Number(parameters[name])
const booleanValue = (parameters: SugarParameters, name: string, fallback = false): boolean => parameters[name] === undefined ? fallback : Boolean(parameters[name])
const bigintValue = (parameters: SugarParameters, name: string): bigint | undefined => parameters[name] === undefined ? undefined : BigInt(String(parameters[name]))

function poolTypeMatches(type: number, requested?: string): boolean {
  return !requested || requested === 'cl' ? !requested || type > 0 : requested === 'stable' ? type === 0 : type === -1
}

function amountJson(amount?: Amount) {
  return amount ? { token: amount.token.symbol, address: amount.token.tokenAddress, amount: amount.decimal, amount_in_stable: amount.amountInStable } : null
}

function epochJson(epoch: LiquidityPoolEpoch) {
  return {
    ts: epoch.ts,
    epoch_date: epoch.epochDate,
    lp: epoch.lp,
    pool: epoch.pool ? {
      symbol: epoch.pool.symbol, type: epoch.pool.type, type_label: poolTypeLabel(epoch.pool.type),
      is_cl: epoch.pool.isCl, is_stable: epoch.pool.isStable, gauge: epoch.pool.gauge, gauge_alive: epoch.pool.gaugeAlive,
    } : null,
    votes: epoch.votes,
    emissions: epoch.emissions,
    total_fees: epoch.totalFees,
    total_incentives: epoch.totalIncentives,
    fees: epoch.fees.map(amountJson),
    incentives: epoch.incentives.map(amountJson),
  }
}

function positionJson(position: Position) {
  return {
    chain_id: position.chainId,
    chain_name: position.chainName,
    id: position.id,
    pool: {
      symbol: position.pool.symbol,
      lp: position.pool.lp,
      is_cl: position.pool.isCl,
      token0: { symbol: position.pool.token0.symbol, decimals: position.pool.token0.decimals },
      token1: { symbol: position.pool.token1.symbol, decimals: position.pool.token1.decimals },
    },
    liquidity: position.liquidity,
    staked: position.staked,
    amount_token0: position.amountToken0,
    amount_token1: position.amountToken1,
    staked_token0: position.stakedToken0,
    staked_token1: position.stakedToken1,
    unstaked_earned0: position.unstakedEarned0,
    unstaked_earned1: position.unstakedEarned1,
    emissions_earned: position.emissionsEarned,
    tick_lower: position.tickLower,
    tick_upper: position.tickUpper,
    sqrt_ratio_lower: position.sqrtRatioLower,
    sqrt_ratio_upper: position.sqrtRatioUpper,
    alm: position.alm,
  }
}

/** Compact pool context attached to transaction-building action outputs. */
function positionPoolJson(pool: LiquidityPool) {
  return {
    symbol: pool.symbol,
    lp: pool.lp,
    is_cl: pool.isCl,
    type_label: poolTypeLabel(pool.type),
    token0: pool.token0.symbol,
    token0_address: pool.token0.tokenAddress,
    token1: pool.token1.symbol,
    token1_address: pool.token1.tokenAddress,
  }
}

function transactionPlan(transactions: Awaited<ReturnType<SugarClient['stake']>>) {
  return {
    transactions,
    transaction_steps: transactions.map((transaction, index) => ({
      role: index === transactions.length - 1 ? 'action' as const : 'approval' as const,
      transaction,
    })),
  }
}

type PoolForSwapJson = Awaited<ReturnType<SugarClient['getPoolsForSwaps']>>[number]

function swapPoolJson(item: PoolForSwapJson) {
  return {
    chain_id: item.chainId, chain_name: item.chainName, lp: item.lp, type: item.type,
    token0_address: item.token0Address, token1_address: item.token1Address,
    factory: item.factory ?? null,
    is_cl: item.isCl, is_stable: item.isStable, type_label: poolTypeLabel(item.type),
  }
}

function fullPoolJson(item: LiquidityPool) {
  return {
    chain_id: item.chainId, chain_name: item.chainName, lp: item.lp, symbol: item.symbol,
    type: item.type, type_label: poolTypeLabel(item.type), is_cl: item.isCl, is_stable: item.isStable,
    pool_fee: item.poolFee, tvl: item.tvl,
    token0: { symbol: item.token0.symbol, address: item.token0.tokenAddress, decimals: item.token0.decimals },
    token1: { symbol: item.token1.symbol, address: item.token1.tokenAddress, decimals: item.token1.decimals },
    reserve0: item.reserve0?.decimal ?? null, reserve1: item.reserve1?.decimal ?? null,
    gauge: item.gauge, gauge_alive: item.gaugeAlive, weekly_emissions: item.weeklyEmissions?.decimal ?? null,
  }
}

const requireToken = Effect.fn('SugarActions.requireToken')(function* (
  client: SugarClient,
  reference: string | undefined,
  label: string,
) {
  if (!reference) throw new Error(`${label} is required`)
  const token = yield* clientCall(() => client.getToken(reference))
  if (!token) throw new Error(`${label} not found: ${reference}`)
  return token
})

const findPosition = Effect.fn('SugarActions.findPosition')(function* (
  client: SugarClient,
  parameters: SugarParameters,
) {
  const pool = stringValue(parameters, 'pool')?.toLowerCase()
  const position = stringValue(parameters, 'position')
  if (!pool && position === undefined) throw new Error('requires pool or position')
  const id = position === undefined ? 0n : BigInt(position)
  if (id === 0n && !pool) throw new Error('position=0 is ambiguous; pass pool too')
  const match = id > 0n
    ? yield* clientCall(() => client.getPositionById(id, client.account, pool ? normalizeAddress(pool) : undefined))
    : pool ? yield* clientCall(() => client.getPositionByPool(normalizeAddress(pool))) : undefined
  if (!match) throw new Error('position not found')
  return match
})

function parseAmount(token: Token, value: string | undefined, useDecimals: boolean): bigint | undefined {
  if (value === undefined) return undefined
  return useDecimals ? parseTokenUnits(token, value) : BigInt(value)
}

/** Best-effort USD prices for price-impact context; never fails the quote. */
const optionalQuotePrices = Effect.fn('SugarActions.optionalQuotePrices')(function* (
  client: SugarClient,
  quote: Quote,
) {
  const [native, stable] = yield* Effect.all([
    clientCall(() => client.getToken(client.settings.nativeTokenSymbol)),
    clientCall(() => client.getToken(client.settings.stableTokenAddress)),
  ], { concurrency: 'unbounded' })
  const tokens = [...new Map([quote.input.fromToken, quote.input.toToken, native, stable].filter((token): token is Token => token !== undefined).map((token) => [token.tokenAddress, token])).values()]
  const prices = new Map((yield* clientCall(() => client.getPrices(tokens))).map((price) => [price.token.tokenAddress, price.price]))
  return {
    fromPrice: prices.get(quote.input.fromToken.tokenAddress),
    toPrice: prices.get(quote.input.toToken.tokenAddress),
  }
})

const quoteJson = Effect.fn('SugarActions.quoteJson')(function* (
  client: SugarClient,
  quote: Quote,
) {
  const { fromPrice, toPrice } = yield* optionalQuotePrices(client, quote).pipe(
    Effect.catchCause(() => Effect.succeed({ fromPrice: undefined, toPrice: undefined })),
  )
  const route = yield* Effect.forEach(
    quote.input.path.slice(0, -1),
    ({ pool, reversed }) => Effect.gen(function* () {
      const address = reversed ? pool.token0Address : pool.token1Address
      const token = yield* clientCall(() => client.getToken(address))
      return { symbol: token?.symbol ?? null, address, lp: pool.lp, type_label: poolTypeLabel(pool.type) }
    }),
    { concurrency: 'unbounded' },
  )
  const amountInDecimal = tokenToNumber(quote.input.fromToken, quote.input.amountIn)
  const amountOutDecimal = tokenToNumber(quote.input.toToken, quote.amountOut)
  const expected = fromPrice && toPrice ? amountInDecimal * fromPrice / toPrice : undefined
  const impact = expected ? (expected - amountOutDecimal) / expected : undefined
  return {
    from_token: { symbol: quote.input.fromToken.symbol, address: quote.input.fromToken.tokenAddress, decimals: quote.input.fromToken.decimals },
    to_token: { symbol: quote.input.toToken.symbol, address: quote.input.toToken.tokenAddress, decimals: quote.input.toToken.decimals },
    amount_in: quote.input.amountIn, amount_out: quote.amountOut,
    amount_in_decimal: amountInDecimal, amount_out_decimal: amountOutDecimal,
    price: amountInDecimal ? amountOutDecimal / amountInDecimal : 0,
    from_price_usd: fromPrice ?? null, to_price_usd: toPrice ?? null,
    price_impact: impact ?? null, price_impact_pct: impact === undefined ? null : impact * 100,
    route,
  }
})

/**
 * Guard candidate routes against outputs more than double the on-chain
 * oracle's expectation. A simulated quote that far above fair value is a
 * honeypot signal (the pool quotes well but the transfer rugs at execution),
 * mirroring the official sdk.js impactTooHigh rejection. Skipped for
 * unlisted tokens, where the oracle has no reliable rate.
 */
const tooGoodToBeTrueFilter = Effect.fn('SugarActions.tooGoodToBeTrueFilter')(function* (
  client: SugarClient,
  fromToken: Token,
  toToken: Token,
  amount: bigint,
) {
  if (!fromToken.listed || !toToken.listed) return undefined
  const prices = yield* clientCall(() => client.getPrices([fromToken, toToken])).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (!prices) return undefined
  const fromPrice = prices.find((price) => price.token.tokenAddress === fromToken.tokenAddress)?.price
  const toPrice = prices.find((price) => price.token.tokenAddress === toToken.tokenAddress)?.price
  if (!fromPrice || !toPrice) return undefined
  const ceiling = 2 * tokenToNumber(fromToken, amount) * (fromPrice / toPrice)
  if (!Number.isFinite(ceiling) || ceiling <= 0) return undefined
  return (quote: Quote) => tokenToNumber(toToken, quote.amountOut) < ceiling
})

const resolveSwapQuote = Effect.fn('SugarActions.resolveSwapQuote')(function* (
  client: SugarClient,
  parameters: SugarParameters,
) {
  const fromToken = yield* requireToken(client, stringValue(parameters, 'from_token'), 'from-token')
  const toToken = yield* requireToken(client, stringValue(parameters, 'to_token'), 'to-token')
  const raw = stringValue(parameters, 'amount')!
  const amount = booleanValue(parameters, 'use_decimals') ? parseTokenUnits(fromToken, raw) : BigInt(raw)
  const filter = yield* tooGoodToBeTrueFilter(client, fromToken, toToken, amount)
  const quote = yield* clientCall(() => client.getQuote(fromToken, toToken, amount, filter))
  if (!quote) throw new Error(`no quote found for ${fromToken.symbol} -> ${toToken.symbol}`)
  return quote
})

const executePositions = Effect.fn('SugarActions.positions')(function* (client: SugarClient, p: SugarParameters) {
  const owner = stringValue(p, 'owner') ?? stringValue(p, 'wallet')
  if (!owner) throw new Error('positions requires wallet or owner')
  const positions = yield* clientCall(() => client.getPositions(normalizeAddress(owner)))
  return positions.map(positionJson)
})

const executePools = Effect.fn('SugarActions.pools')(function* (client: SugarClient, p: SugarParameters) {
  const token0 = stringValue(p, 'token0') ? yield* requireToken(client, stringValue(p, 'token0'), 'token') : undefined
  const token1 = stringValue(p, 'token1') ? yield* requireToken(client, stringValue(p, 'token1'), 'token') : undefined
  const wanted = [token0, token1]
    .filter((token): token is Token => token !== undefined)
    .map((token) => token.tokenAddress.toLowerCase())
  const matches = (type: number, addresses: string[]) =>
    wanted.every((address) => addresses.map((item) => item.toLowerCase()).includes(address))
      && poolTypeMatches(type, stringValue(p, 'pool_type'))
  const limit = p.limit === undefined ? undefined : Number(p.limit)
  if (booleanValue(p, 'full')) {
    const pools = yield* clientCall(() => client.getPools())
    const filtered = pools.filter((pool) => matches(pool.type, [pool.token0.tokenAddress, pool.token1.tokenAddress]))
    return filtered.slice(0, limit).map(fullPoolJson)
  }
  const pools = yield* clientCall(() => client.getPoolsForSwaps())
  const filtered = pools.filter((pool) => matches(pool.type, [pool.token0Address, pool.token1Address]))
  return filtered.slice(0, limit).map(swapPoolJson)
})

const executeEpochsLatest = Effect.fn('SugarActions.epochsLatest')(function* (client: SugarClient, p: SugarParameters) {
  const epochs = yield* clientCall(() => client.getLatestPoolEpochs())
  return epochs.filter((epoch) => epoch.pool && poolTypeMatches(epoch.pool.type, stringValue(p, 'pool_type'))).map(epochJson)
})

const executeEpochs = Effect.fn('SugarActions.epochs')(function* (client: SugarClient, p: SugarParameters) {
  const epochs = yield* clientCall(() => client.getPoolEpochs(stringValue(p, 'lp')!, numberValue(p, 'offset') ?? 0, numberValue(p, 'limit') ?? 10))
  return epochs.filter((epoch) => !epoch.pool || poolTypeMatches(epoch.pool.type, stringValue(p, 'pool_type'))).map(epochJson)
})

const executeQuote = Effect.fn('SugarActions.quote')(function* (client: SugarClient, p: SugarParameters) {
  return yield* quoteJson(client, yield* resolveSwapQuote(client, p))
})

const executeSwap = Effect.fn('SugarActions.swap')(function* (client: SugarClient, p: SugarParameters) {
  const quote = yield* resolveSwapQuote(client, p)
  const slippage = numberValue(p, 'slippage') ?? client.settings.swapSlippage
  const transactions = yield* clientCall(() => client.swapFromQuote(quote, slippage))
  const minAmountOut = applySlippage(quote.amountOut, slippage)
  return {
    ...transactionPlan(transactions),
    quote: {
      ...(yield* quoteJson(client, quote)),
      slippage,
      min_amount_out: minAmountOut,
      min_amount_out_decimal: tokenToNumber(quote.input.toToken, minAmountOut),
    },
  }
})

const executeDeposit = Effect.fn('SugarActions.deposit')(function* (client: SugarClient, p: SugarParameters) {
  let pool: LiquidityPool
  const poolAddress = stringValue(p, 'pool')
  if (poolAddress) {
    const found = yield* clientCall(() => client.getPoolByAddress(poolAddress))
    if (!found) throw new Error(`pool ${poolAddress} not found`)
    pool = found
  } else {
    const token0 = yield* requireToken(client, stringValue(p, 'token0'), 'token0')
    const token1 = yield* requireToken(client, stringValue(p, 'token1'), 'token1')
    const poolType = stringValue(p, 'pool_type')
    pool = yield* clientCall(() => client.poolSpec(token0, token1, poolType === 'cl' ? { tickSpacing: numberValue(p, 'tick_spacing') } : { stable: poolType === 'stable' }))
  }
  const useDecimals = booleanValue(p, 'use_decimals')
  const amountToken0 = parseAmount(pool.token0, stringValue(p, 'amount0'), useDecimals)
  const amountToken1 = parseAmount(pool.token1, stringValue(p, 'amount1'), useDecimals)
  const clOnly = ['price_lower', 'price_upper', 'tick_lower', 'tick_upper', 'initial_price']
    .some((name) => p[name] !== undefined)
  if (!pool.isCl && clOnly) throw new Error('basic deposits do not accept CL flags')
  let quote
  if (pool.isCl) {
    quote = yield* clientCall(() => client.quoteConcentratedDeposit(pool, {
      amountToken0, amountToken1, priceLower: numberValue(p, 'price_lower'), priceUpper: numberValue(p, 'price_upper'),
      tickLower: numberValue(p, 'tick_lower'), tickUpper: numberValue(p, 'tick_upper'), initialPrice: numberValue(p, 'initial_price'),
    }))
  } else if (pool.lp === ADDRESS_ZERO) {
    if (amountToken0 === undefined || amountToken1 === undefined) throw new Error('new basic pool requires both amounts')
    quote = { pool, amountToken0, amountToken1, sqrtPriceX96: 0n }
  } else {
    quote = yield* clientCall(() => client.quoteBasicDeposit(pool, { amountToken0, amountToken1 }))
  }
  const depositQuote = quote
  const transactions = yield* clientCall(() => client.deposit(depositQuote, numberValue(p, 'deadline_minutes') ?? 30, numberValue(p, 'slippage') ?? 0.01))
  return {
    ...transactionPlan(transactions),
    deposit: {
      pool: positionPoolJson(pool),
      creates_pool: pool.lp === ADDRESS_ZERO,
      amount0: depositQuote.amountToken0,
      amount0_decimal: tokenToNumber(pool.token0, depositQuote.amountToken0),
      amount1: depositQuote.amountToken1,
      amount1_decimal: tokenToNumber(pool.token1, depositQuote.amountToken1),
      tick_lower: depositQuote.tickLower ?? null,
      tick_upper: depositQuote.tickUpper ?? null,
    },
  }
})

const executeCreateVeNft = Effect.fn('SugarActions.createVeNft')(function* (client: SugarClient, p: SugarParameters) {
  const contracts = yield* clientCall(() => client.getVeNftContracts())
  const governanceToken = yield* clientCall(() => client.getToken(contracts.governanceToken))
  if (!governanceToken) {
    throw new Error(`governance token not found: ${contracts.governanceToken}`)
  }
  const rawAmount = stringValue(p, 'amount')!
  const veNftAmount = booleanValue(p, 'use_decimals')
    ? parseTokenUnits(governanceToken, rawAmount)
    : BigInt(rawAmount)
  const lockDurationSeconds = numberValue(p, 'lock_duration_seconds')!
  const transactions = yield* clientCall(() => client.createVeNft(veNftAmount, lockDurationSeconds))
  return {
    ...transactionPlan(transactions),
    ve_nft: {
      amount: veNftAmount,
      amount_decimal: tokenToNumber(governanceToken, veNftAmount),
      amount_formatted: formatUnits(veNftAmount, governanceToken.decimals),
      governance_token: governanceToken.tokenAddress,
      governance_symbol: governanceToken.symbol,
      lock_duration_seconds: lockDurationSeconds,
    },
  }
})

const executeWithdraw = Effect.fn('SugarActions.withdraw')(function* (client: SugarClient, p: SugarParameters) {
  const position = yield* findPosition(client, p)
  const withdrawal = withdrawalFromPosition(position, { fraction: stringValue(p, 'fraction'), burn: booleanValue(p, 'burn') })
  const transactions = yield* clientCall(() => client.withdraw(withdrawal, numberValue(p, 'deadline_minutes') ?? 30, numberValue(p, 'slippage') ?? 0.01, booleanValue(p, 'collect', true), booleanValue(p, 'unwrap_native')))
  return {
    ...transactionPlan(transactions),
    withdrawal: {
      pool: positionPoolJson(position.pool),
      position: position.id,
      liquidity: withdrawal.liquidity,
      amount0: withdrawal.amountToken0,
      amount0_decimal: tokenToNumber(position.pool.token0, withdrawal.amountToken0),
      amount1: withdrawal.amountToken1,
      amount1_decimal: tokenToNumber(position.pool.token1, withdrawal.amountToken1),
      burn: withdrawal.burn,
    },
  }
})

/** Position-scoped transaction builders share the position lookup and context shape. */
const executePositionAction = Effect.fn('SugarActions.positionAction')(function* (
  client: SugarClient,
  p: SugarParameters,
  build: (position: Position) => Promise<Awaited<ReturnType<SugarClient['stake']>>>,
) {
  const position = yield* findPosition(client, p)
  const transactions = yield* clientCall(() => build(position))
  return {
    ...transactionPlan(transactions),
    position: { id: position.id, pool: positionPoolJson(position.pool) },
  }
})

type ActionHandler = (client: SugarClient, p: SugarParameters) => Effect.Effect<unknown, unknown>

const ACTION_HANDLERS = {
  stocks: (client) => clientCall(() => stockMarket(client)),
  stock_buy: (client, p) => clientCall(() => stockTrade(client, 'buy', String(p.stock), String(p.amount), Number(p.slippage ?? 0.01))),
  stock_sell: (client, p) => clientCall(() => stockTrade(client, 'sell', String(p.stock), String(p.amount), Number(p.slippage ?? 0.01))),
  index_rebalance: (client, p) => clientCall(() => rebalanceIndex(client, String(p.allocations), String(p.cash ?? '0'), Number(p.slippage ?? 0.01))),
  positions: executePositions,
  pools: executePools,
  epochs_latest: executeEpochsLatest,
  epochs: executeEpochs,
  quote: executeQuote,
  swap: executeSwap,
  deposit: executeDeposit,
  create_venft: executeCreateVeNft,
  withdraw: executeWithdraw,
  stake: (client, p) => executePositionAction(client, p, (position) => client.stake(position)),
  unstake: (client, p) => executePositionAction(client, p, (position) => client.unstake(position, bigintValue(p, 'amount'))),
  claim_emissions: (client, p) => executePositionAction(client, p, (position) => client.claimEmissions(position)),
  claim_fees: (client, p) => executePositionAction(client, p, (position) => client.claimFees(position, booleanValue(p, 'burn'), booleanValue(p, 'unwrap_native'))),
} satisfies Record<SugarAction, ActionHandler>

/** Effect-native action entrypoint used by the promise wrappers below. */
export const executeSugarActionEffect = Effect.fn('SugarActions.execute')(function* <T>(
  action: SugarAction,
  rawParameters: T,
  options: SugarExecutionOptions = {},
) {
  const parameters = validateSugarRequest(action, rawParameters)
  const { clientFactory = (chainId, clientOptions) => new SugarClient(chainId, clientOptions), ...clientOptions } = options
  const walletParameter = stringValue(parameters, 'wallet')
  const client = clientFactory(Number(parameters.chain), {
    ...clientOptions,
    account: walletParameter === undefined ? clientOptions.account : normalizeAddress(walletParameter),
  })
  return toSugarJson(yield* ACTION_HANDLERS[action](client, parameters))
})

export async function executeSugarAction<T>(action: SugarAction, rawParameters: T, options: SugarExecutionOptions = {}): Promise<SugarJson> {
  return runSugar(executeSugarActionEffect(action, rawParameters, options))
}

export async function executeSugarActionJson<T>(action: SugarAction, parameters: T, options: SugarExecutionOptions = {}): Promise<string> {
  return JSON.stringify(await executeSugarAction(action, parameters, options), null, 2)
}
