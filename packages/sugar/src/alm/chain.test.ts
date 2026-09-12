import { describe, expect, test } from 'bun:test'
import { averageTick, checkTwapGate, pushTickSample, type TickHistory } from './chain'

describe('ALM local TWAP', () => {
  test('weights elapsed time rather than sample count', () => {
    const history = { samples: [{ at: 0, tick: 0 }, { at: 90, tick: 100 }, { at: 100, tick: 100 }] }
    expect(averageTick(history, 100, 100)).toBe(10)
  })

  test('clips the first interval and rounds negative ticks down', () => {
    expect(averageTick({ samples: [{ at: 0, tick: -1 }, { at: 49, tick: -1 }, { at: 99, tick: 0 }, { at: 100, tick: 0 }] }, 50, 100)).toBe(-1)
  })

  test('requires full coverage and rejects stale, future, or unordered samples', () => {
    expect(averageTick({ samples: [{ at: 20, tick: 0 }, { at: 100, tick: 0 }] }, 100, 100)).toBeUndefined()
    expect(averageTick({ samples: [{ at: 0, tick: 0 }, { at: 40, tick: 0 }] }, 100, 100)).toBeUndefined()
    expect(averageTick({ samples: [{ at: 0, tick: 0 }, { at: 101, tick: 0 }] }, 100, 100)).toBeUndefined()
    expect(averageTick({ samples: [{ at: 0, tick: 0 }, { at: 90, tick: 0 }, { at: 80, tick: 0 }] }, 100, 100)).toBeUndefined()
  })

  test('keeps the predecessor needed to cover the start of the window', () => {
    const history: TickHistory = { samples: [{ at: 0, tick: 1 }, { at: 80, tick: 2 }] }
    pushTickSample(history, 3, 110, 100)
    expect(history.samples[0].at).toBe(0)
    expect(averageTick(history, 100, 110)).toBe(1)
  })

  test('non-finite oracle values fail closed', () => {
    expect(checkTwapGate(0, Number.NaN, 50).allowed).toBe(false)
    expect(checkTwapGate(Number.NaN, 0, 50).allowed).toBe(false)
  })
})
