import { describe, expect, test } from 'bun:test'
import type { LiquidityPool, LiquidityPoolEpoch, Token } from '../../types'
import { buildOnchainAnalytics, classifyLane, isSaneTurnover, rollupWeekly, weekStart } from './metrics'

const token = (symbol: string, address: string): Token => ({
  chainId: 8453,
  chainName: 'Base',
  tokenAddress: address,
  symbol,
  decimals: 18,
  listed: true,
  emerging: false,
})

const weth = token('WETH', '0x4200000000000000000000000000000000000006')
const usdc = token('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const aero = token('AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631')
const cbbtc = token('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')

function amount(of: Token, decimal: number, price: number) {
  return {
    token: of,
    amount: BigInt(Math.round(decimal * 1e18)),
    price: { token: of, price },
    decimal,
    amountInStable: decimal * price,
  }
}

function pool(partial: Partial<LiquidityPool> & Pick<LiquidityPool, 'lp' | 'symbol' | 'token0' | 'token1'>): LiquidityPool {
  return {
    chainId: 8453,
    chainName: 'Base',
    factory: '0x0000000000000000000000000000000000000001',
    type: partial.isCl ? 100 : partial.isStable ? 0 : -1,
    isStable: partial.isStable ?? false,
    isCl: partial.isCl ?? false,
    tick: 0,
    sqrtRatio: 0n,
    totalSupply: 0n,
    decimals: 18,
    poolFee: 30n,
    gauge: '0x0000000000000000000000000000000000000002',
    gaugeAlive: true,
    gaugeTotalSupply: 0n,
    nfpm: '0x0000000000000000000000000000000000000003',
    alm: '0x0000000000000000000000000000000000000000',
    tvl: 0,
    totalFees: 0,
    volume: 0,
    token0Volume: 0,
    token1Volume: 0,
    apr: 0,
    ...partial,
  }
}

describe('classifyLane', () => {
  test('splits the major Aerodrome pair families', () => {
    expect(classifyLane('WETH', 'USDC')).toBe('eth-stable')
    expect(classifyLane('cbBTC', 'WETH')).toBe('btc')
    expect(classifyLane('USDC', 'DAI')).toBe('stables')
    expect(classifyLane('AERO', 'WETH')).toBe('aero')
    expect(classifyLane('DEGEN', 'WETH')).toBe('long-tail')
  })
})

describe('buildOnchainAnalytics', () => {
  test('computes E/R, RPV, composition, and three-doors from a settled epoch', () => {
    const cl = pool({
      lp: '0x1111111111111111111111111111111111111111',
      symbol: 'CL100-WETH/USDC',
      token0: weth,
      token1: usdc,
      isCl: true,
      tvl: 80_000_000,
      volume: 400_000_000,
      totalFees: 120_000,
      apr: 26,
      emissionsToken: aero,
      emissions: amount(aero, 1, 0.4),
      weeklyEmissions: amount(aero, 1_000_000, 0.4),
    })
    const vamm = pool({
      lp: '0x2222222222222222222222222222222222222222',
      symbol: 'vAMM-AERO/WETH',
      token0: aero,
      token1: weth,
      tvl: 20_000_000,
      volume: 5_000_000,
      totalFees: 8_000,
      apr: 12,
      emissionsToken: aero,
      emissions: amount(aero, 1, 0.4),
      weeklyEmissions: amount(aero, 250_000, 0.4),
    })
    const btc = pool({
      lp: '0x3333333333333333333333333333333333333333',
      symbol: 'CL100-WETH/cbBTC',
      token0: weth,
      token1: cbbtc,
      isCl: true,
      tvl: 10_000_000,
      volume: 30_000_000,
    })
    const epochs: LiquidityPoolEpoch[] = [
      {
        ts: 1_700_000_000,
        lp: cl.lp,
        pool: cl,
        votes: 5_000_000n * 10n ** 18n,
        emissions: 800_000n * 10n ** 18n,
        incentives: [amount(usdc, 40_000, 1)],
        fees: [amount(usdc, 100_000, 1)],
        totalFees: 100_000,
        totalIncentives: 40_000,
        epochDate: '2023-11-14T00:00:00.000Z',
      },
      {
        ts: 1_700_000_000,
        lp: vamm.lp,
        pool: vamm,
        votes: 1_000_000n * 10n ** 18n,
        emissions: 200_000n * 10n ** 18n,
        incentives: [],
        fees: [amount(usdc, 5_000, 1)],
        totalFees: 5_000,
        totalIncentives: 0,
        epochDate: '2023-11-14T00:00:00.000Z',
      },
    ]

    const report = buildOnchainAnalytics([cl, vamm, btc], epochs)
    expect(report.tokenSymbol).toBe('AERO')
    expect(report.aeroPrice).toBe(0.4)
    expect(report.tvl).toBe(110_000_000)
    expect(report.settled.fees).toBe(105_000)
    expect(report.settled.incentives).toBe(40_000)
    expect(report.settled.emissionsUsd).toBeCloseTo(400_000, 4)
    expect(report.settled.revenue).toBe(145_000)
    expect(report.settled.erRatio).toBeCloseTo(400_000 / 145_000, 6)
    expect(report.settled.netIncome).toBeCloseTo(-255_000, 4)
    expect(report.efficiency.slipstream).toBeGreaterThan(report.efficiency.legacy)
    expect(report.composition.byType[0]?.value).toBe(90_000_000)
    expect(report.rpvLeaders[0]?.symbol).toBe('CL100-WETH/USDC')
    expect(report.rpvLeaders[0]?.rpv).toBeCloseTo((140_000 / 5_000_000) * 10_000, 6)
    expect(report.threeDoors.votePool).toBe('CL100-WETH/USDC')
    expect(report.threeDoors.lpPool).toBe('CL100-WETH/USDC')
    expect(report.threeDoors.voteApr).toBeGreaterThan(0)
  })
})

describe('isSaneTurnover', () => {
  test('rejects dust TVL and absurd fee-implied volume', () => {
    expect(isSaneTurnover(80_000_000, 400_000_000)).toBe(true)
    expect(isSaneTurnover(200_000, 5_000_000)).toBe(false)
    expect(isSaneTurnover(10_000_000, 10_000_000_000)).toBe(false)
  })
})

describe('week rollup', () => {
  test('unix weeks start on Thursday and sum daily points', () => {
    expect(weekStart(0)).toBe(0)
    expect(weekStart(604_799)).toBe(0)
    expect(weekStart(604_800)).toBe(604_800)
    const thursday = 12 * 604_800
    const rolled = rollupWeekly([
      [thursday + 86_400, 10],
      [thursday + 2 * 86_400, 5],
      [thursday - 86_400, 7],
    ], 3, thursday + 3 * 86_400)
    expect(rolled).toHaveLength(3)
    expect(rolled[2]?.ts).toBe(thursday)
    expect(rolled[2]?.value).toBe(15)
    expect(rolled[1]?.value).toBe(7)
    expect(rolled[0]?.value).toBe(0)
  })
})
