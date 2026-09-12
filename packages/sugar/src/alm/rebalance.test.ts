import { describe, expect, test } from 'bun:test'
import { planRangeSwap, token0ValueShare } from './rebalance'

describe('token0ValueShare', () => {
  test('is 1 below the interval and 0 above it', () => {
    expect(token0ValueShare(-3_000, -2_000, 2_000)).toBe(1)
    expect(token0ValueShare(-2_000, -2_000, 2_000)).toBe(1)
    expect(token0ValueShare(3_000, -2_000, 2_000)).toBe(0)
    expect(token0ValueShare(2_000, -2_000, 2_000)).toBe(0)
  })

  test('is ~0.5 at the center of a symmetric interval', () => {
    expect(token0ValueShare(0, -2_000, 2_000)).toBeCloseTo(0.5, 2)
  })

  test('shrinks as the tick climbs toward the upper edge', () => {
    const low = token0ValueShare(-1_500, -2_000, 2_000)
    const mid = token0ValueShare(0, -2_000, 2_000)
    const high = token0ValueShare(1_500, -2_000, 2_000)
    expect(low).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(high)
    expect(low).toBeLessThan(1)
    expect(high).toBeGreaterThan(0)
  })
})

describe('planRangeSwap', () => {
  test('needs no swap when holdings already match the interval ratio', () => {
    // Center of a symmetric interval: ~50/50 by value. price=2 → 100 token0 = 200 token1 value.
    const swap = planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 2, amount0Decimal: 100, amount1Decimal: 200 })
    expect(swap.direction).toBe('none')
  })

  test('sells token0 when everything is in token0 and the interval needs both', () => {
    const swap = planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 2, amount0Decimal: 100, amount1Decimal: 0 })
    expect(swap.direction).toBe('0->1')
    if (swap.direction !== '0->1') throw new Error('unreachable')
    // ~half the token0 value must move to token1.
    expect(swap.amountDecimal).toBeCloseTo(50, 0)
  })

  test('sells token1 when everything is in token1', () => {
    const swap = planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 2, amount0Decimal: 0, amount1Decimal: 200 })
    expect(swap.direction).toBe('1->0')
    if (swap.direction !== '1->0') throw new Error('unreachable')
    expect(swap.amountDecimal).toBeCloseTo(100, 0)
  })

  test('lazy repositioning above the tick keeps everything in token0 (no swap)', () => {
    // Interval entirely above the tick holds only token0 — all-token0 holdings need no swap.
    const swap = planRangeSwap({ tick: -2_649, tickLower: -2_600, tickUpper: 1_400, price: 1, amount0Decimal: 500, amount1Decimal: 0 })
    expect(swap.direction).toBe('none')
  })

  test('lazy repositioning below the tick keeps everything in token1 (no swap)', () => {
    const swap = planRangeSwap({ tick: 2_649, tickLower: -1_400, tickUpper: 2_600, price: 1, amount0Decimal: 0, amount1Decimal: 500 })
    expect(swap.direction).toBe('none')
  })

  test('ignores dust imbalances below the minimum swap fraction', () => {
    const swap = planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 2, amount0Decimal: 100.4, amount1Decimal: 200 })
    expect(swap.direction).toBe('none')
  })

  test('handles empty holdings and rejects bad prices', () => {
    expect(planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 2, amount0Decimal: 0, amount1Decimal: 0 }).direction).toBe('none')
    expect(() => planRangeSwap({ tick: 0, tickLower: -2_000, tickUpper: 2_000, price: 0, amount0Decimal: 1, amount1Decimal: 1 })).toThrow('price')
  })
})
