import type { LiquidityPool, LiquidityPoolEpoch } from '../../types'

export const WEEK_SECONDS = 604_800
export const RPV_UNIT = 10_000

export type AssetLane = 'eth-stable' | 'btc' | 'stables' | 'aero' | 'long-tail'

export type PoolScore = {
  lp: string
  symbol: string
  typeLabel: string
  isCl: boolean
  lane: AssetLane
  tvl: number
  volume: number
  fees: number
  efficiency: number
  votes: number
  emissionsUsd: number
  incentives: number
  revenue: number
  erRatio: number | undefined
  rpv: number | undefined
  bribeRoi: number | undefined
  voteShare: number
}

export type CompositionSlice<K extends string = string> = { key: K; label: string; value: number }

export type ThreeDoors = {
  capitalUsd: number
  holdWeeklyUsd: number
  lpWeeklyUsd: number
  lpApr: number
  lpPool?: string
  voteWeeklyUsd: number
  voteApr: number
  votePool?: string
}

export type EpochScorecard = {
  epochDate?: string
  ts?: number
  volume: number
  fees: number
  incentives: number
  revenue: number
  emissionsUsd: number
  netIncome: number
  erRatio: number | undefined
  poolCount: number
  topByVotes: PoolScore[]
}

export type OnchainAnalytics = {
  tokenSymbol: string
  aeroPrice: number
  tvl: number
  volume: number
  poolFees: number
  weeklyEmissionsUsd: number
  settled: EpochScorecard
  composition: {
    byType: CompositionSlice<'slipstream' | 'volatile' | 'stable'>[]
    byLane: CompositionSlice<AssetLane>[]
    stableShare: number
  }
  efficiency: { overall: number; slipstream: number; legacy: number }
  pools: PoolScore[]
  rpvLeaders: PoolScore[]
  feeEngines: PoolScore[]
  bribeLeaders: PoolScore[]
  threeDoors: ThreeDoors
}

const ETH = new Set(['ETH', 'WETH'])
const BTC = new Set(['CBBTC', 'WBTC', 'TBTC', 'BTC'])
const STABLE = new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'USD+', 'USDS', 'USDE', 'CRVUSD',
  'DOLA', 'EURC', 'EUSD', 'USDC.E', 'USDT0',
])
const AERO = new Set(['AERO', 'VELO'])

export function weekStart(ts: number): number {
  return ts - (ts % WEEK_SECONDS)
}

export function classifyLane(symbol0: string, symbol1: string): AssetLane {
  const left = symbol0.toUpperCase()
  const right = symbol1.toUpperCase()
  const pair = [left, right]
  const isEth = pair.some((symbol) => ETH.has(symbol))
  const isBtc = pair.some((symbol) => BTC.has(symbol))
  const isStable = pair.every((symbol) => STABLE.has(symbol))
  const hasStable = pair.some((symbol) => STABLE.has(symbol))
  const isAero = pair.some((symbol) => AERO.has(symbol))
  if (isBtc) return 'btc'
  if (isEth && hasStable) return 'eth-stable'
  if (isStable) return 'stables'
  if (isAero) return 'aero'
  return 'long-tail'
}

export function laneLabel(lane: AssetLane): string {
  if (lane === 'eth-stable') return 'ETH-stable'
  if (lane === 'btc') return 'BTC'
  if (lane === 'stables') return 'Stables'
  if (lane === 'aero') return 'AERO/VELO'
  return 'Long-tail'
}

export function typeFamily(isCl: boolean, isStable: boolean): 'slipstream' | 'stable' | 'volatile' {
  if (isCl) return 'slipstream'
  return isStable ? 'stable' : 'volatile'
}

function weiToNumber(value: bigint): number {
  return Number(value) / 1e18
}

/** Fee-implied volume on dust / mis-priced pools is not a turnover number. */
export function isSaneTurnover(tvl: number, volume: number): boolean {
  if (tvl < 1_000_000 || volume <= 0 || !Number.isFinite(volume / tvl)) return false
  const turns = volume / tvl
  return turns >= 0.01 && turns <= 40
}

function ratio(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined
  return numerator / denominator
}

export function buildOnchainAnalytics(pools: LiquidityPool[], epochs: LiquidityPoolEpoch[]): OnchainAnalytics {
  const tokenSymbol = pools.find((pool) => pool.emissionsToken)?.emissionsToken?.symbol
    ?? (pools[0]?.chainId === 10 ? 'VELO' : 'AERO')
  const aeroPrice = pools.find((pool) => pool.emissionsToken && (pool.emissions?.price.price ?? 0) > 0)?.emissions?.price.price
    ?? 0
  const epochByLp = new Map(epochs.map((epoch) => [epoch.lp.toLowerCase(), epoch]))
  const scored = pools.map((pool): PoolScore => {
    const epoch = epochByLp.get(pool.lp.toLowerCase())
    const votes = epoch ? weiToNumber(epoch.votes) : 0
    const emissionsUsd = epoch ? weiToNumber(epoch.emissions) * aeroPrice : 0
    const fees = epoch?.totalFees ?? 0
    const incentives = epoch?.totalIncentives ?? 0
    const revenue = fees + incentives
    return {
      lp: pool.lp,
      symbol: pool.symbol,
      typeLabel: pool.isCl ? 'CL' : pool.isStable ? 'sAMM' : 'vAMM',
      isCl: pool.isCl,
      lane: classifyLane(pool.token0.symbol, pool.token1.symbol),
      tvl: pool.tvl,
      volume: pool.volume,
      fees,
      efficiency: pool.tvl > 0 ? pool.volume / pool.tvl : 0,
      votes,
      emissionsUsd,
      incentives,
      revenue,
      erRatio: ratio(emissionsUsd, revenue),
      rpv: ratio(revenue, votes) === undefined ? undefined : (revenue / Math.max(votes, 1e-12)) * RPV_UNIT,
      bribeRoi: ratio(votes, incentives),
      voteShare: 0,
    }
  })

  const totalVotes = scored.reduce((sum, pool) => sum + pool.votes, 0)
  for (const pool of scored) pool.voteShare = totalVotes > 0 ? pool.votes / totalVotes : 0

  const tvl = pools.reduce((sum, pool) => sum + pool.tvl, 0)
  const volume = pools.reduce((sum, pool) => sum + pool.volume, 0)
  const poolFees = pools.reduce((sum, pool) => sum + pool.totalFees, 0)
  const weeklyEmissionsUsd = pools.reduce((sum, pool) => sum + (pool.weeklyEmissions?.amountInStable ?? 0), 0)

  const typeTotals = new Map<string, number>()
  const laneTotals = new Map<AssetLane, number>()
  let stableTvl = 0
  for (const pool of pools) {
    const family = typeFamily(pool.isCl, pool.isStable)
    typeTotals.set(family, (typeTotals.get(family) ?? 0) + pool.tvl)
    const lane = classifyLane(pool.token0.symbol, pool.token1.symbol)
    laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + pool.tvl)
    if (lane === 'stables' || STABLE.has(pool.token0.symbol.toUpperCase()) || STABLE.has(pool.token1.symbol.toUpperCase())) {
      if (lane === 'stables') stableTvl += pool.tvl
    }
  }

  const byType: OnchainAnalytics['composition']['byType'] = [
    { key: 'slipstream', label: 'Slipstream', value: typeTotals.get('slipstream') ?? 0 },
    { key: 'volatile', label: 'vAMM', value: typeTotals.get('volatile') ?? 0 },
    { key: 'stable', label: 'sAMM', value: typeTotals.get('stable') ?? 0 },
  ]
  const byLane: OnchainAnalytics['composition']['byLane'] = (['eth-stable', 'btc', 'stables', 'aero', 'long-tail'] as const).map((lane) => ({
    key: lane,
    label: laneLabel(lane),
    value: laneTotals.get(lane) ?? 0,
  }))

  const turnoverPools = pools.filter((pool) => isSaneTurnover(pool.tvl, pool.volume))
  const slipTurnover = turnoverPools.filter((pool) => pool.isCl)
  const legacyTurnover = turnoverPools.filter((pool) => !pool.isCl)
  const ratioOf = (items: LiquidityPool[]) => {
    const itemTvl = items.reduce((sum, pool) => sum + pool.tvl, 0)
    const itemVol = items.reduce((sum, pool) => sum + pool.volume, 0)
    return itemTvl > 0 ? itemVol / itemTvl : 0
  }

  const settledFees = scored.reduce((sum, pool) => sum + pool.fees, 0)
  const settledIncentives = scored.reduce((sum, pool) => sum + pool.incentives, 0)
  const settledEmissions = scored.reduce((sum, pool) => sum + pool.emissionsUsd, 0)
  const settledRevenue = settledFees + settledIncentives
  const latest = epochs.reduce<LiquidityPoolEpoch | undefined>((best, epoch) => {
    if (!best || epoch.ts > best.ts) return epoch
    return best
  }, undefined)

  const rpvLeaders = scored.filter((pool) => (pool.rpv ?? 0) > 0 && pool.votes > 0)
    .sort((left, right) => (right.rpv ?? 0) - (left.rpv ?? 0))
    .slice(0, 12)
  const feeEngines = [...scored].sort((left, right) => right.fees - left.fees).slice(0, 12)
  const bribeLeaders = scored.filter((pool) => pool.incentives > 0)
    .sort((left, right) => (right.bribeRoi ?? 0) - (left.bribeRoi ?? 0))
    .slice(0, 12)

  const bestVote = rpvLeaders[0]
  const bestLp = [...pools].filter((pool) => pool.tvl > 1_000_000).sort((left, right) => right.apr - left.apr)[0]
    ?? [...pools].sort((left, right) => right.apr - left.apr)[0]
  const capitalUsd = 10_000
  const lockedTokens = aeroPrice > 0 ? capitalUsd / aeroPrice : 0
  const voteWeeklyUsd = bestVote && bestVote.votes > 0
    ? (bestVote.revenue / bestVote.votes) * lockedTokens
    : 0
  const lpApr = bestLp?.apr ?? 0

  return {
    tokenSymbol,
    aeroPrice,
    tvl,
    volume,
    poolFees,
    weeklyEmissionsUsd,
    settled: {
      epochDate: latest?.epochDate,
      ts: latest?.ts,
      volume: scored.reduce((sum, pool) => sum + pool.volume, 0),
      fees: settledFees,
      incentives: settledIncentives,
      revenue: settledRevenue,
      emissionsUsd: settledEmissions,
      netIncome: settledRevenue - settledEmissions,
      erRatio: ratio(settledEmissions, settledRevenue),
      poolCount: scored.filter((pool) => pool.votes > 0 || pool.fees > 0).length,
      topByVotes: [...scored].sort((left, right) => right.votes - left.votes).slice(0, 8),
    },
    composition: {
      byType,
      byLane,
      stableShare: tvl > 0 ? stableTvl / tvl : 0,
    },
    efficiency: {
      overall: ratioOf(turnoverPools),
      slipstream: ratioOf(slipTurnover),
      legacy: ratioOf(legacyTurnover),
    },
    pools: scored,
    rpvLeaders,
    feeEngines,
    bribeLeaders,
    threeDoors: {
      capitalUsd,
      holdWeeklyUsd: 0,
      lpWeeklyUsd: capitalUsd * (lpApr / 100) / 52,
      lpApr,
      lpPool: bestLp?.symbol,
      voteWeeklyUsd,
      voteApr: capitalUsd > 0 ? (voteWeeklyUsd * 52 / capitalUsd) * 100 : 0,
      votePool: bestVote?.symbol,
    },
  }
}

export function rollupWeekly(
  points: Array<readonly [number, number]>,
  weeks = 12,
  now = Math.floor(Date.now() / 1000),
  mode: 'sum' | 'last' = 'sum',
): Array<{ ts: number; value: number }> {
  const end = weekStart(now)
  const start = end - (weeks - 1) * WEEK_SECONDS
  const buckets = new Map<number, number>()
  for (let week = start; week <= end; week += WEEK_SECONDS) buckets.set(week, 0)
  const ordered = mode === 'last' ? [...points].sort((left, right) => left[0] - right[0]) : points
  for (const [ts, value] of ordered) {
    const week = weekStart(ts)
    if (!buckets.has(week)) continue
    buckets.set(week, mode === 'last' ? value : (buckets.get(week) ?? 0) + value)
  }
  return [...buckets.entries()].map(([ts, value]) => ({ ts, value }))
}
