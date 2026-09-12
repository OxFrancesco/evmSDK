import { describe, expect, test } from 'bun:test'
import { assembleLlama, parseProtocolTvl, parseSummary } from './llama'

describe('parseSummary', () => {
  test('splits Slipstream fees from vAMM', () => {
    const parsed = parseSummary({
      total24h: 100,
      total7d: 700,
      totalDataChart: [[604_800, 10]],
      totalDataChartBreakdown: [[604_800, { Base: { 'Aerodrome V1': 4, 'Aerodrome Slipstream': 6 } }]],
    })
    expect(parsed.total24h).toBe(100)
    expect(parsed.family[0]).toEqual({ ts: 604_800, slipstream: 6, legacy: 4 })
  })
})

describe('assembleLlama', () => {
  test('rolls daily fees onto Thursday weeks', () => {
    const now = 3 * 604_800 + 2 * 86_400
    const snapshot = assembleLlama({
      protocol: 'Aerodrome',
      chain: 'base',
      now,
      fees: parseSummary({ total24h: 176_000, total7d: 980_000, totalAllTime: 530_000_000, totalDataChart: [[now, 50], [now - 86_400, 50]] }),
      holders: parseSummary({ total7d: 800_000, totalDataChart: [[now, 40]] }),
      volume: parseSummary({ total24h: 400_000_000, totalDataChart: [[now, 9]] }),
      tvl: parseProtocolTvl({ mcap: 390_000_000, tvl: [{ date: now, totalLiquidityUSD: 300_000_000 }] }),
    })
    expect(snapshot.feesAllTime).toBe(530_000_000)
    expect(snapshot.mcap).toBe(390_000_000)
    expect(snapshot.weeks[snapshot.weeks.length - 1]?.fees).toBe(100)
  })
})
