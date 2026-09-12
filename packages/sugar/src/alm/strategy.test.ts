import { describe, expect, test } from 'bun:test'
import { MAX_ABS_TICK } from '../types'
import {
  centeredInterval,
  decideRange,
  defaultStrategySettings,
  defaultWidthTicks,
  validateStrategySettings,
  type RangeState,
  type StrategySettings,
} from './strategy'

function settings(overrides: Partial<StrategySettings> = {}): StrategySettings {
  return { strategy: 'original', widthTicks: 4_000, tickNeighborhood: 0, expandStepTicks: 400, maxWidthTicks: 8_000, ...overrides }
}

function state(overrides: Partial<RangeState> = {}): RangeState {
  return { tick: 0, tickSpacing: 100, tickLower: -2_000, tickUpper: 2_000, ...overrides }
}

describe('centeredInterval', () => {
  test('centers on the tick aligned to the spacing grid', () => {
    expect(centeredInterval(0, 4_000, 100)).toEqual({ tickLower: -2_000, tickUpper: 2_000 })
    expect(centeredInterval(1_049, 4_000, 100)).toEqual({ tickLower: -1_000, tickUpper: 3_000 })
    expect(centeredInterval(-73, 1_000, 50)).toEqual({ tickLower: -550, tickUpper: 450 })
  })

  test('clamps to the tick domain without shrinking the width', () => {
    const nearMax = centeredInterval(MAX_ABS_TICK - 10, 4_000, 100)
    expect(nearMax.tickUpper).toBeLessThanOrEqual(MAX_ABS_TICK)
    expect(nearMax.tickUpper - nearMax.tickLower).toBe(4_000)
    const nearMin = centeredInterval(-MAX_ABS_TICK + 10, 4_000, 100)
    expect(nearMin.tickLower).toBeGreaterThanOrEqual(-MAX_ABS_TICK)
    expect(nearMin.tickUpper - nearMin.tickLower).toBe(4_000)
  })
})

describe('validateStrategySettings', () => {
  test('rejects widths that are not spacing multiples', () => {
    expect(() => validateStrategySettings(settings({ widthTicks: 4_050 }), 100)).toThrow('multiple of the pool tick spacing')
  })

  test('rejects a neighborhood covering half the interval', () => {
    expect(() => validateStrategySettings(settings({ tickNeighborhood: 2_000 }), 100)).toThrow('less than half')
  })

  test('expand requires an aligned positive step and a sane max width', () => {
    expect(() => validateStrategySettings(settings({ strategy: 'expand', expandStepTicks: 150 }), 100)).toThrow('multiple of the pool tick spacing')
    expect(() => validateStrategySettings(settings({ strategy: 'expand', maxWidthTicks: 2_000 }), 100)).toThrow('at least widthTicks')
  })
})

describe('original strategy', () => {
  test('holds while the tick is inside the active interval', () => {
    expect(decideRange(state({ tick: 1_999 }), settings())).toEqual({ action: 'hold', reason: 'tick is inside the active interval' })
    expect(decideRange(state({ tick: -2_000 }), settings()).action).toBe('hold')
  })

  test('recenters with the same width when the tick exits the interval', () => {
    const decision = decideRange(state({ tick: 2_600 }), settings())
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: 600, tickUpper: 4_600 })
  })

  test('recenters when the tick exits below', () => {
    const decision = decideRange(state({ tick: -2_400 }), settings())
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: -4_400, tickUpper: -400 })
  })

  test('the neighborhood buffer triggers early, before the edge is crossed', () => {
    const buffered = settings({ tickNeighborhood: 500 })
    expect(decideRange(state({ tick: 1_600 }), buffered)).toMatchObject({ action: 'rebalance', tickLower: -400, tickUpper: 3_600 })
    expect(decideRange(state({ tick: 1_400 }), buffered).action).toBe('hold')
  })

  test('holds when recentering reproduces the current interval', () => {
    // Neighborhood-triggered, but the tick still rounds to the same center.
    const same = decideRange(state({ tick: 1_955, tickLower: 0, tickUpper: 4_000 }), settings({ tickNeighborhood: 1_960 }))
    expect(same).toMatchObject({ action: 'hold', reason: 'recentering would produce the same interval' })
  })
})

describe('lazy strategies', () => {
  test('lazy-syncing holds anywhere inside the interval, even at the edges', () => {
    const lazy = settings({ strategy: 'lazy-syncing' })
    expect(decideRange(state({ tick: -2_000 }), lazy).action).toBe('hold')
    expect(decideRange(state({ tick: 1_999 }), lazy).action).toBe('hold')
  })

  test('lazy-syncing places the interval just above a downward breach (no swap needed)', () => {
    const decision = decideRange(state({ tick: -2_649 }), settings({ strategy: 'lazy-syncing' }))
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: -2_600, tickUpper: 1_400 })
  })

  test('lazy-syncing places the interval just below an upward breach (no swap needed)', () => {
    const decision = decideRange(state({ tick: 2_649 }), settings({ strategy: 'lazy-syncing' }))
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: -1_400, tickUpper: 2_600 })
  })

  test('lazy-ascending ignores downward breaches and follows upward ones', () => {
    const lazy = settings({ strategy: 'lazy-ascending' })
    expect(decideRange(state({ tick: -5_000 }), lazy)).toMatchObject({ action: 'hold', reason: 'lazy-ascending ignores downward breaches' })
    expect(decideRange(state({ tick: 5_000 }), lazy)).toMatchObject({ action: 'rebalance', tickLower: 1_000, tickUpper: 5_000 })
  })

  test('lazy-descending ignores upward breaches and follows downward ones', () => {
    const lazy = settings({ strategy: 'lazy-descending' })
    expect(decideRange(state({ tick: 5_000 }), lazy)).toMatchObject({ action: 'hold', reason: 'lazy-descending ignores upward breaches' })
    expect(decideRange(state({ tick: -5_000 }), lazy)).toMatchObject({ action: 'rebalance', tickLower: -5_000, tickUpper: -1_000 })
  })
})

describe('expand strategy (Pulse V2)', () => {
  test('expands uniformly on both sides when the tick exits', () => {
    const decision = decideRange(state({ tick: 2_100 }), settings({ strategy: 'expand' }))
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: -2_400, tickUpper: 2_400 })
  })

  test('keeps expanding until the tick is covered', () => {
    const decision = decideRange(state({ tick: 3_100 }), settings({ strategy: 'expand', maxWidthTicks: 40_000 }))
    expect(decision.action).toBe('rebalance')
    if (decision.action !== 'rebalance') throw new Error('unreachable')
    expect(decision.tickUpper).toBeGreaterThan(3_100)
    expect(decision.tickUpper - decision.tickLower).toBeLessThanOrEqual(40_000)
    expect(decision.tickLower).toBe(-decision.tickUpper)
  })

  test('resets to a centered default-width interval beyond the width limit', () => {
    const decision = decideRange(
      state({ tick: 4_500, tickLower: -3_900, tickUpper: 3_900 }),
      settings({ strategy: 'expand', maxWidthTicks: 8_000 }),
    )
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: 2_500, tickUpper: 6_500 })
    expect(decision.action === 'rebalance' && decision.tickUpper - decision.tickLower).toBe(4_000)
  })

  test('respects the neighborhood early trigger', () => {
    const decision = decideRange(state({ tick: 1_700 }), settings({ strategy: 'expand', tickNeighborhood: 400 }))
    expect(decision).toMatchObject({ action: 'rebalance', tickLower: -2_400, tickUpper: 2_400 })
  })
})

describe('defaults', () => {
  test('mirrors the Mellow production widths per tick spacing', () => {
    expect(defaultWidthTicks(1)).toBe(1)
    expect(defaultWidthTicks(50)).toBe(1_000)
    expect(defaultWidthTicks(100)).toBe(4_000)
    expect(defaultWidthTicks(200)).toBe(6_000)
    expect(defaultWidthTicks(2_000)).toBe(60_000)
  })

  test('default settings validate for every known spacing', () => {
    for (const spacing of [1, 50, 100, 200, 2_000]) {
      const defaults = defaultStrategySettings(spacing)
      expect(() => validateStrategySettings(defaults, spacing)).not.toThrow()
      expect(() => validateStrategySettings({ ...defaults, strategy: 'expand' }, spacing)).not.toThrow()
    }
  })
})
