import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as Schema from 'effect/Schema'
import { almStatePath } from './config'

/**
 * Persisted daemon state: when each position was last rebalanced and
 * compounded. This is what makes cooldowns and the daily rebalance cap
 * survive restarts. Timestamps are epoch milliseconds; rebalance history is
 * pruned to the last 24 hours on every record.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const identifier = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i))
const address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/i))
const quantity = Schema.String.check(Schema.isPattern(/^\d+$/))

const AlmCycleSchema = Schema.Struct({
  id: identifier,
  kind: Schema.Literals(['rebalance', 'compound']),
  chain: Schema.Int,
  wallet: address,
  pool: address,
  positionId: quantity,
  resultPositionId: Schema.optionalKey(quantity),
  tickLower: Schema.Int,
  tickUpper: Schema.Int,
  startedAt: timestamp,
  balances: Schema.Record(Schema.String, quantity),
  phases: Schema.Array(Schema.Struct({ name: Schema.String, executionId: identifier })),
  status: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(['active', 'complete']) }),
    Schema.Struct({ kind: Schema.Literal('resolved'), note: Schema.NonEmptyString }),
  ]),
})
export type AlmCycle = typeof AlmCycleSchema.Type

export type AlmPositionState = {
  configuredPositionId?: string
  managedPositionId?: string
  /** Epoch ms of each rebalance in the last 24h (newest last). */
  rebalances: readonly number[]
  lastCompoundAt?: number
  cycle?: AlmCycle
}

export type AlmState = Record<string, AlmPositionState>

export function managedPositionId(state: AlmPositionState | undefined, configuredId?: bigint): bigint | undefined {
  const id = state?.configuredPositionId === configuredId?.toString()
    ? state?.managedPositionId ?? configuredId?.toString()
    : configuredId?.toString()
  return id === undefined ? undefined : BigInt(id)
}

const AlmStateSchema = Schema.Record(Schema.String, Schema.Struct({
  configuredPositionId: Schema.optional(quantity),
  managedPositionId: Schema.optional(quantity),
  rebalances: Schema.Array(timestamp),
  lastCompoundAt: Schema.optionalKey(timestamp),
  cycle: Schema.optionalKey(AlmCycleSchema),
}))

export function positionStateKey(chain: number, pool: string, wallet?: string): string {
  return wallet ? `${chain}:${wallet.toLowerCase()}:${pool.toLowerCase()}` : `${chain}:${pool.toLowerCase()}`
}

export function loadAlmState(path = almStatePath(), strict = true): AlmState {
  if (!existsSync(path)) return {}
  try {
    return Schema.decodeUnknownSync(AlmStateSchema)(JSON.parse(readFileSync(path, 'utf8')))
  } catch (cause) {
    if (strict) throw new Error(`Invalid ALM safety state at ${path}; restore and review it before execution`, { cause })
    // A corrupt state file must never brick the daemon; caps restart empty.
    return {}
  }
}

export function saveAlmState(state: AlmState, path = almStatePath()): void {
  Schema.decodeUnknownSync(AlmStateSchema)(state)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export function acquireAlmStateLock(path = almStatePath()): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.lock`
  let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch (cause) {
    throw new Error(`ALM state is locked at ${lock}; stop other daemons and inspect stale locks before recovery`, { cause })
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    fsyncSync(fd)
  } catch (cause) {
    closeSync(fd)
    unlinkSync(lock)
    throw cause
  }
  return () => { closeSync(fd); unlinkSync(lock) }
}

export type RebalanceGate =
  | { allowed: true }
  | { allowed: false; reason: string }

/** Cooldown + rolling daily cap check for one position. */
export function checkRebalanceGate(
  state: AlmPositionState | undefined,
  now: number,
  cooldownMinutes: number,
  maxRebalancesPerDay: number,
): RebalanceGate {
  if (state?.cycle?.status.kind === 'active') return { allowed: false, reason: `interrupted ALM cycle ${state.cycle.id}; reconcile and resolve it before execution` }
  const recent = (state?.rebalances ?? []).filter((at) => now - at < DAY_MS)
  if (recent.length >= maxRebalancesPerDay) {
    return { allowed: false, reason: `daily cap reached (${recent.length}/${maxRebalancesPerDay} rebalances in the last 24h)` }
  }
  const last = recent.length > 0 ? Math.max(...recent) : undefined
  if (last !== undefined && now - last < cooldownMinutes * 60_000) {
    const remaining = Math.ceil((cooldownMinutes * 60_000 - (now - last)) / 60_000)
    return { allowed: false, reason: `cooldown active (${remaining} min remaining of ${cooldownMinutes})` }
  }
  return { allowed: true }
}

export function recordRebalance(state: AlmState, key: string, now: number) {
  const entry = state[key] ?? { rebalances: [] }
  const rebalances = [...entry.rebalances.filter((at) => now - at < DAY_MS), now]
  return { ...state, [key]: { ...entry, rebalances } }
}

export function recordCompound(state: AlmState, key: string, now: number) {
  const entry = state[key] ?? { rebalances: [] }
  return { ...state, [key]: { ...entry, lastCompoundAt: now } }
}
