import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshot, writeSnapshot } from './snapshot'

describe('TUI disk snapshots', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aero-snapshot-'))
    previous = process.env.AERO_CACHE_DIR
    process.env.AERO_CACHE_DIR = dir
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.AERO_CACHE_DIR
    else process.env.AERO_CACHE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('round-trips data with its saved timestamp', () => {
    const data = [{ lp: '0xabc', tvl: 123.45, symbol: 'vAMM-WETH/USDC' }]
    const before = Date.now()
    writeSnapshot('pools:{"chain":8453,"full":true}', data)
    const snapshot = readSnapshot<typeof data>('pools:{"chain":8453,"full":true}')
    expect(snapshot?.data).toEqual(data)
    expect(snapshot?.savedAt).toBeGreaterThanOrEqual(before)
  })

  test('distinct keys never collide', () => {
    writeSnapshot('pools:{"chain":8453}', 'base')
    writeSnapshot('pools:{"chain":10}', 'optimism')
    expect(readSnapshot<string>('pools:{"chain":8453}')?.data).toBe('base')
    expect(readSnapshot<string>('pools:{"chain":10}')?.data).toBe('optimism')
  })

  test('missing snapshots return undefined', () => {
    expect(readSnapshot('positions:{"chain":8453}')).toBeUndefined()
  })

  test('expired snapshots are dropped', () => {
    writeSnapshot('epochs_latest:{"chain":8453}', [1, 2, 3])
    const [file] = readdirSync(join(dir, 'snapshots'))
    const path = join(dir, 'snapshots', file!)
    // SAFETY: the file was just produced by writeSnapshot, whose layout the test controls.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { savedAt: number }
    raw.savedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(path, JSON.stringify(raw))
    expect(readSnapshot('epochs_latest:{"chain":8453}')).toBeUndefined()
  })

  test('corrupt files read as missing', () => {
    writeSnapshot('pools:{"chain":8453}', 'ok')
    const [file] = readdirSync(join(dir, 'snapshots'))
    expect(file).toBeDefined()
    writeFileSync(join(dir, 'snapshots', file!), '{ not json')
    expect(readSnapshot('pools:{"chain":8453}')).toBeUndefined()
  })

  test('filenames stay readable and safe', () => {
    writeSnapshot('pools:{"chain":8453,"full":true}', 'x')
    const [file] = readdirSync(join(dir, 'snapshots'))
    expect(file).toMatch(/^pools-[0-9a-f]{16}\.json$/)
  })
})
