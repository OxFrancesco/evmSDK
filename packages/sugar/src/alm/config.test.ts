import { describe, expect, test } from 'bun:test'
import { ALM_DEFAULTS, parseAlmConfig, strategySettingsFor, type AlmPositionConfig } from './config'
import { checkRebalanceGate, loadAlmState, positionStateKey, recordCompound, recordRebalance } from './state'

const POOL = '0x1000000000000000000000000000000000000001'

describe('parseAlmConfig', () => {
  test('preserves exact NFT ids without numeric rounding', () => {
    const positionId = '9007199254740993123'
    expect(parseAlmConfig({ version: 1, positions: [{ pool: POOL, positionId }] }).positions[0].positionId).toBe(9007199254740993123n)
    for (const invalid of ['0', '-1', '1.5', 'not-an-id']) {
      expect(() => parseAlmConfig({ version: 1, positions: [{ pool: POOL, positionId: invalid }] })).toThrow()
    }
  })
  test('applies Mellow-equivalent defaults to a minimal config', () => {
    const config = parseAlmConfig({ version: 1, positions: [{ pool: POOL }] })
    expect(config.chain).toBe(8453)
    expect(config.pollSeconds).toBe(ALM_DEFAULTS.pollSeconds)
    expect(config.telegram).toBe(false)
    expect(config.positions[0]).toMatchObject({
      cooldownMinutes: ALM_DEFAULTS.cooldownMinutes,
      maxRebalancesPerDay: ALM_DEFAULTS.maxRebalancesPerDay,
      slippage: ALM_DEFAULTS.slippage,
      swapSlippage: ALM_DEFAULTS.swapSlippage,
      twapSeconds: ALM_DEFAULTS.twapSeconds,
      maxTwapDeviationTicks: ALM_DEFAULTS.maxTwapDeviationTicks,
      compound: true,
    })
  })

  test('normalizes pool addresses and rejects duplicates', () => {
    const config = parseAlmConfig({ version: 1, positions: [{ pool: POOL.toUpperCase().replace('0X', '0x') }] })
    expect(config.positions[0].pool).toBe(POOL)
    expect(() => parseAlmConfig({ version: 1, positions: [{ pool: POOL }, { pool: POOL.toUpperCase().replace('0X', '0x') }] }))
      .toThrow('duplicate pool')
  })

  test('rejects invalid values with readable messages', () => {
    expect(() => parseAlmConfig({ version: 1, positions: [] })).toThrow('no positions')
    expect(() => parseAlmConfig({ version: 2, positions: [{ pool: POOL }] })).toThrow()
    expect(() => parseAlmConfig({ version: 1, positions: [{ pool: POOL, slippage: 0.9 }] })).toThrow('slippage')
    expect(() => parseAlmConfig({ version: 1, positions: [{ pool: POOL, maxRebalancesPerDay: 0 }] })).toThrow('maxRebalancesPerDay')
    expect(() => parseAlmConfig({ version: 1, positions: [{ pool: POOL, strategy: 'yolo' }] })).toThrow()
    expect(() => parseAlmConfig({ version: 1, positions: [{ pool: 'not-an-address' }] })).toThrow('Invalid address')
  })
})

describe('strategySettingsFor', () => {
  const position = (overrides: Partial<AlmPositionConfig> = {}): AlmPositionConfig =>
    ({ ...parseAlmConfig({ version: 1, positions: [{ pool: POOL }] }).positions[0], ...overrides })

  test('prefers configured width, then the current position width, then Mellow defaults', () => {
    expect(strategySettingsFor(position({ widthTicks: 2_000 }), 100, 5_000).widthTicks).toBe(2_000)
    expect(strategySettingsFor(position(), 100, 5_000).widthTicks).toBe(5_000)
    expect(strategySettingsFor(position(), 100).widthTicks).toBe(4_000)
    expect(strategySettingsFor(position(), 200).widthTicks).toBe(6_000)
  })

  test('defaults the strategy to original', () => {
    expect(strategySettingsFor(position(), 100).strategy).toBe('original')
    expect(strategySettingsFor(position({ strategy: 'expand' }), 100).strategy).toBe('expand')
  })
})

describe('rebalance gate', () => {
  const NOW = 1_700_000_000_000

  test('allows a first rebalance', () => {
    expect(checkRebalanceGate(undefined, NOW, 60, 4)).toEqual({ allowed: true })
  })

  test('enforces the cooldown', () => {
    const gate = checkRebalanceGate({ rebalances: [NOW - 30 * 60_000] }, NOW, 60, 4)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.reason).toContain('cooldown')
  })

  test('enforces the rolling daily cap', () => {
    const rebalances = [1, 2, 3, 4].map((hours) => NOW - hours * 3_600_000)
    const gate = checkRebalanceGate({ rebalances }, NOW, 0, 4)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.reason).toContain('daily cap')
  })

  test('rebalances older than 24h fall out of the cap window', () => {
    const rebalances = [30, 28, 26, 25].map((hours) => NOW - hours * 3_600_000)
    expect(checkRebalanceGate({ rebalances }, NOW, 0, 4)).toEqual({ allowed: true })
  })

  test('recordRebalance prunes old entries and recordCompound stamps the position', () => {
    const key = positionStateKey(8453, POOL)
    let state = recordRebalance({}, key, NOW - 25 * 3_600_000)
    state = recordRebalance(state, key, NOW)
    expect(state[key].rebalances).toEqual([NOW])
    state = recordCompound(state, key, NOW + 1)
    expect(state[key].lastCompoundAt).toBe(NOW + 1)
    expect(state[key].rebalances).toEqual([NOW])
  })
})

describe('loadAlmState', () => {
  test('returns an empty state for a missing file', () => {
    expect(loadAlmState('/nonexistent/alm-state.json')).toEqual({})
  })
})
