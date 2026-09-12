import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { assembleDune, duneApiKey, epochToTs, parseDuneResults, parseRpvLeaders, rowTimestamp } from './dune'

describe('duneApiKey', () => {
  test('prefers SUGAR_DUNE_API_KEY then DUNE_API_KEY', () => {
    expect(duneApiKey({})).toBeUndefined()
    expect(duneApiKey({ DUNE_API_KEY: 'abc' })).toBe('abc')
    expect(duneApiKey({ SUGAR_DUNE_API_KEY: 'sugar', DUNE_API_KEY: 'abc' })).toBe('sugar')
  })

  test('reads dune.env from SUGAR_WALLET_DIR when env is unset', () => {
    const dir = join(tmpdir(), `sugar-dune-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'dune.env'), 'DUNE_API_KEY=from-file\n', { mode: 0o600 })
    expect(duneApiKey({ SUGAR_WALLET_DIR: dir })).toBe('from-file')
  })
})

describe('epochToTs', () => {
  test('accepts unix seconds, millis, unix week index, and sequential epoch', () => {
    expect(epochToTs(1_700_000_000)).toBe(1_700_000_000)
    expect(epochToTs(1_700_000_000_000)).toBe(1_700_000_000)
    expect(epochToTs(2_800)).toBe(2_800 * 604_800)
    expect(epochToTs(10)).toBe(1_692_835_200 + 10 * 604_800)
  })
})

describe('parseDuneResults', () => {
  test('reads rows from the Dune Analytics result envelope', () => {
    const parsed = parseDuneResults({
      execution_ended_at: '2026-08-18T00:00:00Z',
      result: {
        rows: [
          { epoch: 100, tvl: 300_000_000, volume: 2_000_000_000, fees: 800_000 },
        ],
      },
    })
    expect(parsed.endedAt).toBe('2026-08-18T00:00:00Z')
    expect(parsed.rows).toHaveLength(1)
    expect(rowTimestamp(parsed.rows[0] ?? {})).toBe(1_692_835_200 + 100 * 604_800)
  })

  test('surfaces a Dune error string', () => {
    expect(parseDuneResults({ error: 'invalid API Key' }).error).toBe('invalid API Key')
  })
})

describe('assembleDune', () => {
  test('merges Dune weekly volume, Base share, and Hoodie Crew RPV', () => {
    const thursday = 1_692_835_200 + 150 * 604_800
    const now = thursday + 2 * 86_400
    const snapshot = assembleDune({
      now,
      endedAt: '2026-08-18T12:00:00Z',
      weekly: [{ ts: thursday, volume: 1_900_000_000 }],
      share: [
        { project: 'Aerodrome Slipstream', volume24h: 300 },
        { name: 'Aerodrome', volume_24h: 100 },
        { name: 'Uniswap', volume24h: 400 },
        { name: 'PancakeSwap', volume24h: 200 },
      ],
      rpv: [
        { display_name: 'alice.eth', e: 147, rpv: 0.002, veaero: 5_000, share_pct: 0.01, wallet: '0x1' },
        { display_name: 'dust', e: 147, rpv: 0.02, veaero: 1, share_pct: 0, wallet: '0x2' },
        { display_name: 'old', e: 140, rpv: 0.05, veaero: 9_000, share_pct: 0.02, wallet: '0x3' },
      ],
    })
    expect(snapshot.source).toBe('Dune Analytics')
    expect(snapshot.queries.map((query) => query.id)).toEqual([7_907_454])
    expect(snapshot.weeks[snapshot.weeks.length - 1]?.volume).toBe(1_900_000_000)
    expect(snapshot.volume24h).toBe(400)
    expect(snapshot.baseShare24h).toBeCloseTo(400 / 1000, 6)
    expect(snapshot.rivals[0]?.name).toBe('Uniswap')
    expect(snapshot.rpvEpoch).toBe(147)
    expect(snapshot.rpvLeaders.map((row) => row.name)).toEqual(['alice.eth'])
    expect(snapshot.rpvLeaders[0]?.rpvPer10k).toBeCloseTo(20, 6)
  })
})

describe('parseRpvLeaders', () => {
  test('keeps the latest epoch and drops dust wallets', () => {
    const parsed = parseRpvLeaders([
      { display_name: 'keep', e: 10, rpv: 0.001, veaero: 200, wallet: '0x1' },
      { display_name: 'dust', e: 10, rpv: 0.05, veaero: 2, wallet: '0x2' },
    ])
    expect(parsed.epoch).toBe(10)
    expect(parsed.leaders).toHaveLength(1)
    expect(parsed.leaders[0]?.name).toBe('keep')
  })
})
