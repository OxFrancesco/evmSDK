// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Predicate from 'effect/Predicate'
import type { Address } from 'viem'
import { addressKey, createAmount, normalizeAddress, poolSymbol, tokenContractAddress, tupleValues } from './helpers'
import { ADDRESS_ZERO, type Amount, type ChainSettings, type DepositQuote, type LiquidityPool, type LiquidityPoolEpoch, type LiquidityPoolForSwap, type Position, type Price, type Token, type VeNft, type VeNftReward, type VeNftState, type Withdrawal } from './types'

// SAFETY: Sugar contract tuples encode numeric fields as bigint, number, or decimal string; BigInt applies the same coercion the previous boundary relied on.
const asBigint = <T>(value: T): bigint => Predicate.isBigInt(value) ? value : BigInt(value as string | number)
const asNumber = <T>(value: T): number => Predicate.isNumber(value) ? value : Number(value)

export function tokenFromTuple<T>(raw: T, settings: ChainSettings): Token {
  const [address, symbol, decimals, , listed, emerging] = tupleValues(raw)
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    tokenAddress: normalizeAddress(String(address)),
    symbol: String(symbol),
    decimals: asNumber(decimals),
    listed: Boolean(listed),
    emerging: Boolean(emerging),
  }
}

export function nativeToken(settings: ChainSettings): Token {
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    tokenAddress: settings.nativeTokenSymbol,
    symbol: settings.nativeTokenSymbol,
    decimals: settings.nativeTokenDecimals,
    listed: true,
    emerging: false,
    wrappedTokenAddress: settings.wrappedNativeTokenAddress,
  }
}

export function prepareTokens(raw: unknown[], settings: ChainSettings, listedOnly = false): Token[] {
  const tokens = raw.map((item) => tokenFromTuple(item, settings))
  return [nativeToken(settings), ...(listedOnly ? tokens.filter((token) => token.listed) : tokens)]
}

export function preparePrices(tokens: Token[], rates: bigint[], settings: ChainSettings): Price[] {
  if (tokens.length !== rates.length) throw new Error('price response length does not match token request')
  const normalized = new Map<string, bigint>()
  tokens.forEach((token, index) => {
    const rate = rates[index] ?? 0n
    const shift = settings.nativeTokenDecimals - token.decimals
    normalized.set(token.tokenAddress, shift === 0 ? rate : shift > 0 ? rate / 10n ** BigInt(shift) : rate * 10n ** BigInt(-shift))
  })
  const nativeRate = normalized.get(settings.nativeTokenSymbol) ?? 0n
  const stable = tokens.find((token) => addressKey(token.tokenAddress) === addressKey(settings.stableTokenAddress))
  if (!stable) throw new Error(`Stable token ${settings.stableTokenAddress} is missing from the price request`)
  const stableRate = normalized.get(stable.tokenAddress) ?? 0n
  if (stableRate === 0n) throw new Error('Stable token oracle rate is zero')
  const scale = 10n ** BigInt(settings.nativeTokenDecimals)
  const nativeStablePrice = (nativeRate * scale) / stableRate
  return tokens.map((token) => ({
    token,
    price: Number(((normalized.get(token.tokenAddress) ?? 0n) * nativeStablePrice) / scale) / Number(scale),
  }))
}

export function poolForSwapFromTuple<T>(raw: T, settings: ChainSettings): LiquidityPoolForSwap {
  const values = tupleValues(raw)
  const type = asNumber(values[1])
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    lp: normalizeAddress(String(values[0])),
    type,
    token0Address: normalizeAddress(String(values[2])),
    token1Address: normalizeAddress(String(values[3])),
    factory: values[4] ? normalizeAddress(String(values[4])) : undefined,
    isCl: type > 0,
    isStable: type >= 0 && type <= 50,
    isBasic: type === 0 || type === -1,
  }
}

function sumStable(amounts: Array<Amount | undefined>): number {
  return amounts.reduce((sum, item) => sum + (item?.amountInStable ?? 0), 0)
}

export function poolFromTuple<T>(
  raw: T,
  tokens: Map<string, Token>,
  prices: Map<string, Price>,
  settings: ChainSettings,
): LiquidityPool | undefined {
  const t = tupleValues(raw)
  const token0Address = normalizeAddress(String(t[7]))
  const token1Address = normalizeAddress(String(t[10]))
  const token0 = tokens.get(addressKey(token0Address))
  const token1 = tokens.get(addressKey(token1Address))
  if (!token0 || !token1) return undefined
  const type = asNumber(t[4])
  const reserve0 = createAmount(token0Address, asBigint(t[8]), tokens, prices)
  const reserve1 = createAmount(token1Address, asBigint(t[11]), tokens, prices)
  const token0Fees = createAmount(token0Address, asBigint(t[24]), tokens, prices)
  const token1Fees = createAmount(token1Address, asBigint(t[25]), tokens, prices)
  const emissionsTokenAddress = normalizeAddress(String(t[20]))
  const emissions = createAmount(emissionsTokenAddress, asBigint(t[19]), tokens, prices)
  const weeklyEmissions = createAmount(emissionsTokenAddress, asBigint(t[19]) * 604_800n, tokens, prices)
  const totalSupply = asBigint(t[3])
  const gaugeTotalSupply = asBigint(t[14])
  const tvl = sumStable([reserve0, reserve1])
  const totalFees = sumStable([token0Fees, token1Fees])
  const poolFee = asBigint(t[22])
  const volumeMultiplier = poolFee === 0n ? 0 : 10_000 / Number(poolFee)
  const stakedPercent = totalSupply === 0n ? 0 : 100 * Number(gaugeTotalSupply) / Number(totalSupply)
  const stakedTvl = tvl * stakedPercent / 100
  const rewardValue = emissions?.amountInStable ?? 0
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    lp: normalizeAddress(String(t[0])),
    factory: normalizeAddress(String(t[18])),
    symbol: poolSymbol(token0, token1, type),
    type,
    isStable: type === 0,
    isCl: type > 0,
    tick: asNumber(t[5]),
    sqrtRatio: asBigint(t[6]),
    totalSupply,
    decimals: asNumber(t[2]),
    token0,
    reserve0,
    token1,
    reserve1,
    token0Fees,
    token1Fees,
    poolFee,
    gauge: normalizeAddress(String(t[13])),
    gaugeAlive: Boolean(t[15]),
    gaugeTotalSupply,
    emissions,
    emissionsToken: tokens.get(addressKey(emissionsTokenAddress)),
    weeklyEmissions,
    nfpm: normalizeAddress(String(t[29])),
    alm: normalizeAddress(String(t[30])),
    tvl,
    totalFees,
    volume: totalFees * volumeMultiplier,
    token0Volume: token0Fees ? Number(token0Fees.amount) * volumeMultiplier : 0,
    token1Volume: token1Fees ? Number(token1Fees.amount) * volumeMultiplier : 0,
    apr: stakedTvl === 0 ? 0 : ((rewardValue * 86_400) / stakedTvl) * 36_500,
  }
}

export function preparePools(raw: unknown[], tokens: Token[], prices: Price[], settings: ChainSettings): LiquidityPool[] {
  const tokenMap = new Map(tokens.map((token) => [addressKey(token.tokenAddress), token]))
  const priceMap = new Map(prices.map((price) => [addressKey(price.token.tokenAddress), price]))
  return raw.map((item) => poolFromTuple(item, tokenMap, priceMap, settings)).filter((pool): pool is LiquidityPool => pool !== undefined)
}

export function epochFromTuple<T>(raw: T, pools: Map<string, LiquidityPool>, tokens: Map<string, Token>, prices: Map<string, Price>): LiquidityPoolEpoch {
  const t = tupleValues(raw)
  const amount = <A>(rawAmount: A): Amount | undefined => {
    const [address, value] = tupleValues(rawAmount)
    return createAmount(normalizeAddress(String(address)), asBigint(value), tokens, prices)
  }
  const incentives = tupleValues(t[4]).map(amount).filter((item): item is Amount => item !== undefined)
  const fees = tupleValues(t[5]).map(amount).filter((item): item is Amount => item !== undefined)
  const ts = asNumber(t[0])
  const lp = normalizeAddress(String(t[1]))
  return {
    ts,
    lp,
    pool: pools.get(addressKey(lp)),
    votes: asBigint(t[2]),
    emissions: asBigint(t[3]),
    incentives,
    fees,
    totalFees: sumStable(fees),
    totalIncentives: sumStable(incentives),
    epochDate: new Date(ts * 1000).toISOString(),
  }
}

export function veNftFromTuple<TRaw, TState>(raw: TRaw, stateValue: TState, settings: ChainSettings): VeNft {
  const t = tupleValues(raw)
  const states: VeNftState[] = ['normal', 'locked', 'managed']
  const state = states[asNumber(stateValue)]
  if (!state) throw new Error(`Unknown veNFT escrow type: ${String(stateValue)}`)
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    id: asBigint(t[0]),
    owner: normalizeAddress(String(t[1])),
    decimals: asNumber(t[2]),
    lockedAmount: asBigint(t[3]),
    votingPower: asBigint(t[4]),
    governancePower: asBigint(t[5]),
    claimableRebase: asBigint(t[6]),
    expiresAt: asNumber(t[7]),
    votedAt: asNumber(t[8]),
    votes: tupleValues(t[9]).map((vote) => {
      const [pool, weight] = tupleValues(vote)
      return { pool: normalizeAddress(String(pool)), weight: asBigint(weight) }
    }),
    governanceToken: normalizeAddress(String(t[10])),
    permanent: Boolean(t[11]),
    delegateId: asBigint(t[12]),
    managedId: asBigint(t[13]),
    state,
  }
}

export function veNftRewardFromTuple<T>(raw: T): VeNftReward {
  const t = tupleValues(raw)
  return {
    veNftId: asBigint(t[0]),
    pool: normalizeAddress(String(t[1])),
    amount: asBigint(t[2]),
    token: normalizeAddress(String(t[3])),
    feeVotingReward: normalizeAddress(String(t[4])),
    incentiveVotingReward: normalizeAddress(String(t[5])),
  }
}

export function positionFromTuple<T>(raw: T, pools: Map<string, LiquidityPool>, settings: ChainSettings): Position | undefined {
  const t = tupleValues(raw)
  const lp = normalizeAddress(String(t[1]))
  const pool = pools.get(addressKey(lp))
  if (!pool) return undefined
  const alm = normalizeAddress(String(t[17]))
  const tickLower = asNumber(t[11])
  const tickUpper = asNumber(t[12])
  return {
    chainId: settings.chainId,
    chainName: settings.chainName,
    id: asBigint(t[0]),
    pool,
    liquidity: asBigint(t[2]),
    staked: asBigint(t[3]),
    amountToken0: asBigint(t[4]),
    amountToken1: asBigint(t[5]),
    stakedToken0: asBigint(t[6]),
    stakedToken1: asBigint(t[7]),
    unstakedEarned0: asBigint(t[8]),
    unstakedEarned1: asBigint(t[9]),
    emissionsEarned: asBigint(t[10]),
    tickLower,
    tickUpper,
    sqrtRatioLower: asBigint(t[13]),
    sqrtRatioUpper: asBigint(t[14]),
    alm,
    isCl: pool.isCl,
    isAlm: alm !== ADDRESS_ZERO,
    isInRange: pool.isCl && tickLower <= pool.tick && pool.tick < tickUpper,
  }
}

export function createPoolSpec(
  settings: ChainSettings,
  token0: Token,
  token1: Token,
  options: { tickSpacing?: number; stable?: boolean; basicFactoryAddress?: Address },
): LiquidityPool {
  if ((options.tickSpacing === undefined) === (options.stable === undefined)) throw new Error('supply exactly one of tickSpacing / stable')
  if (token0.chainId !== settings.chainId || token1.chainId !== settings.chainId) throw new Error('Pool tokens must belong to the client chain')
  if (addressKey(tokenContractAddress(token0)) >= addressKey(tokenContractAddress(token1))) throw new Error('tokens must be canonically ordered by contract address, using the wrapped address for native tokens')
  const isCl = options.tickSpacing !== undefined
  if (isCl && options.tickSpacing! <= 0) throw new Error('tickSpacing must be positive')
  if (!isCl && !options.basicFactoryAddress) throw new Error('basic pool requires basicFactoryAddress')
  const type = isCl ? options.tickSpacing! : options.stable ? 0 : -1
  return {
    chainId: settings.chainId, chainName: settings.chainName, lp: ADDRESS_ZERO,
    factory: isCl ? ADDRESS_ZERO : options.basicFactoryAddress!, symbol: poolSymbol(token0, token1, type),
    type, isStable: type === 0, isCl, tick: 0, sqrtRatio: 0n, totalSupply: 0n, decimals: 0,
    token0, token1, poolFee: 0n, gauge: ADDRESS_ZERO, gaugeAlive: false, gaugeTotalSupply: 0n,
    nfpm: isCl ? settings.nfpmContractAddress : ADDRESS_ZERO, alm: ADDRESS_ZERO,
    tvl: 0, totalFees: 0, volume: 0, token0Volume: 0, token1Volume: 0, apr: 0,
  }
}

export function validateDepositQuote(quote: DepositQuote): DepositQuote {
  if (quote.pool.isCl) {
    if (quote.tickLower === undefined || quote.tickUpper === undefined) throw new Error('CL DepositQuote requires tickLower and tickUpper')
    if (quote.tickLower >= quote.tickUpper) throw new Error('tickLower must be < tickUpper')
    if (quote.tickLower % quote.pool.type !== 0 || quote.tickUpper % quote.pool.type !== 0) throw new Error(`tick bounds must be multiples of tick spacing (${quote.pool.type})`)
  } else if (quote.tickLower !== undefined || quote.tickUpper !== undefined || quote.sqrtPriceX96 !== 0n) {
    throw new Error('basic DepositQuote must not set tick / sqrtPriceX96 fields')
  }
  return quote
}

function fractionRatio(value: number | string): [numerator: bigint, denominator: bigint] {
  const text = String(value).trim().toLowerCase()
  if (text.length > 1_024) throw new Error('fraction is too precise')
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(text)
  if (!match) throw new Error('fraction must be a decimal number')
  const decimals = match[2]?.length ?? 0
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) throw new Error('fraction exponent is too large')
  const digits = BigInt(`${match[1]}${match[2] ?? ''}`)
  const scale = decimals - exponent
  if (Math.abs(scale) > 1_000) throw new Error('fraction is too precise')
  return scale >= 0
    ? [digits, 10n ** BigInt(scale)]
    : [digits * 10n ** BigInt(-scale), 1n]
}

export function withdrawalFromPosition(position: Position, options: { fraction?: number | string; burn?: boolean } = {}): Withdrawal {
  const fraction = options.fraction ?? 1
  const burn = options.burn ?? false
  const [numerator, denominator] = fractionRatio(fraction)
  if (numerator <= 0n || numerator > denominator) throw new Error('fraction must be in (0, 1]')
  if (burn && numerator !== denominator) throw new Error('burn requires fraction=1.0 (full close)')
  if (burn && !position.isCl) throw new Error('burn is CL-only')
  if (position.liquidity === 0n) throw new Error('position has no liquidity to withdraw')
  const scale = (value: bigint) => numerator === denominator ? value : value * numerator / denominator
  const liquidity = scale(position.liquidity)
  if (liquidity === 0n) throw new Error('fraction too small: computed liquidity is 0')
  return {
    pool: position.pool,
    liquidity,
    amountToken0: scale(position.amountToken0),
    amountToken1: scale(position.amountToken1),
    positionId: position.isCl ? position.id : undefined,
    burn,
  }
}

export function findToken(tokens: Token[], reference: string | bigint | number): Token | undefined {
  let ref = String(reference)
  if (Predicate.isBigInt(reference) || Predicate.isNumber(reference)) ref = `0x${BigInt(reference).toString(16).padStart(40, '0')}`
  if (ref.startsWith('0x')) return tokens.find((token) => {
    try { return addressKey(token.tokenAddress) === addressKey(normalizeAddress(ref)) }
    catch { return false }
  })
  const matches = tokens.filter((token) => token.symbol.toLowerCase() === ref.toLowerCase())
  const native = matches.find((token) => token.wrappedTokenAddress !== undefined)
  if (native) return native
  const unique = new Map(matches.map((token) => [addressKey(token.tokenAddress), token]))
  if (unique.size > 1) throw new Error(`Ambiguous token symbol ${ref}; use a contract address`)
  return unique.values().next().value
}

export function bridgeToken(tokens: Token[], settings: ChainSettings): Token {
  const token = tokens.find((item) => !item.wrappedTokenAddress && addressKey(item.tokenAddress) === addressKey(settings.bridgeTokenAddress))
  if (!token) throw new Error(`Superswap bridge token not found on ${settings.chainName} chain`)
  return token
}
