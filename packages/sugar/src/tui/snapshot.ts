import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Predicate from 'effect/Predicate'

/**
 * Best-effort disk snapshots for the TUI's stale-while-revalidate layer.
 * Screens render a snapshot instantly (badged with its age) while the live
 * chain scan refreshes in the background, so neither a cold launch nor an
 * expired in-memory TTL ever blocks on the full Sugar pagination sweep.
 *
 * Snapshots only ever feed browse/analytics screens — quotes and transaction
 * building always read live chain state.
 */

const SNAPSHOT_VERSION = 1
/** Older data is more confusing than a spinner; drop it. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000

export type Snapshot<T> = { savedAt: number; data: T }

function snapshotDir(): string {
  const override = process.env.AERO_CACHE_DIR
  if (override) return join(override, 'snapshots')
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  return join(base, 'aero', 'snapshots')
}

function snapshotPath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const label = (key.split(':')[0] ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'snapshot'
  return join(snapshotDir(), `${label}-${hash}.json`)
}

export function readSnapshot<T>(key: string, maxAgeMs = MAX_SNAPSHOT_AGE_MS): Snapshot<T> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(snapshotPath(key), 'utf8'))
    if (parsed === null || !Predicate.isObject(parsed) || Array.isArray(parsed)) return undefined
    // SAFETY: only writeSnapshot produces this versioned file, and it stores
    // exactly the caller's T under `data`; the version and field checks below
    // reject foreign or outdated layouts.
    const { v, savedAt, data } = parsed as { v?: unknown; savedAt?: unknown; data?: T }
    if (v !== SNAPSHOT_VERSION || !Predicate.isNumber(savedAt) || data === undefined) return undefined
    if (Date.now() - savedAt > maxAgeMs) return undefined
    return { savedAt, data }
  } catch {
    return undefined
  }
}

export function writeSnapshot<T>(key: string, data: T): void {
  try {
    const path = snapshotPath(key)
    mkdirSync(snapshotDir(), { recursive: true })
    // Atomic rename: a crash mid-write must never leave a torn snapshot.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ v: SNAPSHOT_VERSION, savedAt: Date.now(), data }))
    renameSync(temp, path)
  } catch {
    // Snapshots are an optimization; the live scan is the source of truth.
  }
}
