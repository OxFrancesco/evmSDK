/**
 * Dune Analytics (dune.com) client.
 * Pulls the latest results of public Aerodrome queries and, when useful,
 * runs a small SQL job against Dune's indexed tables.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toSugarJson } from '../../helpers'
import type { SugarJson } from '../../types'
import { jsonNumber, jsonRecord, jsonString } from '../format'
import { weekStart } from './metrics'

export type DuneQuery = {
  id: number
  author: string
  title: string
  dashboard: string
}

export type DuneWeek = {
  ts: number
  fees: number
  holders: number
  volume: number
  tvl: number
  emissions: number
  bribes: number
  slipstreamFees: number
  legacyFees: number
  slipstreamVolume: number
  legacyVolume: number
}

export type DuneRival = {
  name: string
  volume24h: number
  volume7d: number
  fees24h: number
  tvl: number
}

export type DuneSnapshot = {
  source: string
  chain: string
  queries: DuneQuery[]
  executedAt?: string
  tvlNow?: number
  fees24h?: number
  fees7d?: number
  fees30d?: number
  volume24h?: number
  volume7d?: number
  holdersRevenue24h?: number
  holdersRevenue7d?: number
  weeks: DuneWeek[]
  rivals: DuneRival[]
  rpvLeaders: DuneRpvRow[]
  rpvEpoch?: number
  baseVolume24h?: number
  baseShare24h?: number
}

export type DuneRpvRow = {
  name: string
  wallet: string
  epoch: number
  rpv: number
  rpvPer10k: number
  veaero: number
  sharePct: number
}

export const DUNE_AERO_RPV: DuneQuery = {
  id: 7_907_454,
  author: 'hollywood41x',
  title: 'Aerodrome RPV leaderboard',
  dashboard: 'https://dune.com/hollywood41x/aerodrome-rpv-leaderboard-hoodie-crew',
}

const AERO_QUERIES = [DUNE_AERO_RPV]
const AERO_GENESIS = 1_692_835_200
const WEEK = 604_800
const WEEKS = 16

const TIME_KEYS = ['ts', 'week', 'epoch', 'epoch_date', 'date', 'day', 'block_date', 'time', 'dt', 'period']
const TVL_KEYS = ['tvl', 'tvl_usd', 'current_tvl', 'total_tvl']
const VOLUME_KEYS = ['volume', 'volume_usd', 'vol', 'swap_volume']
const FEE_KEYS = ['fees', 'swap_fees', 'fees_usd', 'fee_usd', 'total_fees']
const HOLDER_KEYS = ['holders_revenue', 'voter_revenue', 'revenue', 'rewards']
const EMISSION_KEYS = ['emissions', 'emissions_usd', 'aero_emissions', 'emission_usd']
const BRIBE_KEYS = ['bribes', 'bribes_usd', 'incentives', 'incentives_usd']
const SLIP_FEE_KEYS = ['slipstream_fees', 'cl_fees', 'slip_fees']
const LEGACY_FEE_KEYS = ['legacy_fees', 'v1_fees', 'vamm_fees']
const SLIP_VOL_KEYS = ['slipstream_volume', 'cl_volume', 'slip_volume']
const LEGACY_VOL_KEYS = ['legacy_volume', 'v1_volume', 'vamm_volume']
const NAME_KEYS = ['name', 'project', 'protocol', 'display_name']
const VOL24_KEYS = ['volume24h', 'volume_24h', 'vol_24h', 'amount_usd', 'volume']

export type DuneRow = Record<string, SugarJson>

function readDuneKeyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  let found: string | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals === -1) continue
    const name = trimmed.slice(0, equals).trim()
    if (name !== 'DUNE_API_KEY' && name !== 'SUGAR_DUNE_API_KEY') continue
    let value = trimmed.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1)
    if (name === 'SUGAR_DUNE_API_KEY' && value) return value
    if (value) found = value
  }
  return found
}

export function duneApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const fromEnv = env.SUGAR_DUNE_API_KEY ?? env.DUNE_API_KEY
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const dir = env.SUGAR_WALLET_DIR ?? (env === process.env ? join(homedir(), '.config', 'sugar-ts') : undefined)
  if (!dir) return undefined
  return readDuneKeyFile(join(dir, 'dune.env'))
}

function jsonArray(value: SugarJson | undefined): SugarJson[] {
  return Array.isArray(value) ? value : []
}

function rowNumber(row: DuneRow, keys: string[]): number | undefined {
  const lookup = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]))
  for (const wanted of keys) {
    const actual = lookup.get(wanted.toLowerCase())
    if (actual === undefined) continue
    const value = jsonNumber(row[actual])
    if (value !== undefined) return value
  }
  return undefined
}

function rowText(row: DuneRow, keys: string[]): string | undefined {
  const lookup = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]))
  for (const wanted of keys) {
    const actual = lookup.get(wanted.toLowerCase())
    if (actual === undefined) continue
    const value = jsonString(row[actual])
    if (value) return value
  }
  return undefined
}

export function epochToTs(value: number): number {
  if (value > 1_000_000_000_000) return Math.floor(value / 1000)
  if (value > 1_000_000_000) return Math.floor(value)
  if (value > 2_000) return value * WEEK
  return AERO_GENESIS + value * WEEK
}

export function rowTimestamp(row: DuneRow): number | undefined {
  const numeric = rowNumber(row, TIME_KEYS)
  if (numeric !== undefined) return weekStart(epochToTs(numeric))
  const text = rowText(row, TIME_KEYS)
  if (!text) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? weekStart(Math.floor(parsed / 1000)) : undefined
}

export type DuneParsedResults = { rows: DuneRow[]; endedAt?: string; error?: string }

const EMPTY_RESULTS: DuneParsedResults = { rows: [] }

export function parseDuneResults(raw: SugarJson): DuneParsedResults {
  const record = jsonRecord(raw)
  if (!record) return EMPTY_RESULTS
  const error = jsonString(record.error) ?? jsonString(jsonRecord(record.error ?? null)?.message)
  const result = jsonRecord(record.result ?? null)
  const rows: DuneRow[] = []
  for (const item of jsonArray(result?.rows ?? record.rows)) {
    const row = jsonRecord(item)
    if (row) rows.push(row)
  }
  return { rows, endedAt: jsonString(record.execution_ended_at), error }
}

function emptyWeek(ts: number): DuneWeek {
  return {
    ts, fees: 0, holders: 0, volume: 0, tvl: 0, emissions: 0, bribes: 0,
    slipstreamFees: 0, legacyFees: 0, slipstreamVolume: 0, legacyVolume: 0,
  }
}

function mergeRow(week: DuneWeek, row: DuneRow): void {
  week.fees = rowNumber(row, FEE_KEYS) ?? week.fees
  week.holders = rowNumber(row, HOLDER_KEYS) ?? week.holders
  week.volume = rowNumber(row, VOLUME_KEYS) ?? week.volume
  week.tvl = rowNumber(row, TVL_KEYS) ?? week.tvl
  week.emissions = rowNumber(row, EMISSION_KEYS) ?? week.emissions
  week.bribes = rowNumber(row, BRIBE_KEYS) ?? week.bribes
  week.slipstreamFees = rowNumber(row, SLIP_FEE_KEYS) ?? week.slipstreamFees
  week.legacyFees = rowNumber(row, LEGACY_FEE_KEYS) ?? week.legacyFees
  week.slipstreamVolume = rowNumber(row, SLIP_VOL_KEYS) ?? week.slipstreamVolume
  week.legacyVolume = rowNumber(row, LEGACY_VOL_KEYS) ?? week.legacyVolume
}

export type ParsedRpv = { epoch?: number; leaders: DuneRpvRow[] }

export function parseRpvLeaders(rows: DuneRow[]): ParsedRpv {
  const parsed = rows.flatMap((row): DuneRpvRow[] => {
    const epoch = rowNumber(row, ['e', 'epoch'])
    const rpv = rowNumber(row, ['rpv'])
    const veaero = rowNumber(row, ['veaero', 've_aero', 'voting_power']) ?? 0
    if (epoch === undefined || rpv === undefined) return []
    return [{
      name: rowText(row, ['display_name', 'name']) ?? rowText(row, ['wallet']) ?? 'unknown',
      wallet: rowText(row, ['wallet', 'address']) ?? '',
      epoch,
      rpv,
      rpvPer10k: rpv * 10_000,
      veaero,
      sharePct: rowNumber(row, ['share_pct', 'share']) ?? 0,
    }]
  })
  const latest = parsed.reduce<number | undefined>((max, row) => max === undefined || row.epoch > max ? row.epoch : max, undefined)
  const leaders = parsed
    .filter((row) => row.epoch === latest && row.veaero >= 100)
    .sort((left, right) => right.rpv - left.rpv)
    .slice(0, 12)
  return { epoch: latest, leaders }
}

export function assembleDune(input: {
  overview?: DuneRow[]
  economics?: DuneRow[]
  weekly?: DuneRow[]
  share: DuneRow[]
  rpv?: DuneRow[]
  endedAt?: string
  now?: number
}): DuneSnapshot {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const end = weekStart(now)
  const start = end - (WEEKS - 1) * WEEK
  const weeks = new Map<number, DuneWeek>()
  for (let ts = start; ts <= end; ts += WEEK) weeks.set(ts, emptyWeek(ts))

  for (const row of [...(input.overview ?? []), ...(input.economics ?? []), ...(input.weekly ?? [])]) {
    const ts = rowTimestamp(row)
    if (ts === undefined || !weeks.has(ts)) continue
    const week = weeks.get(ts)
    if (week) mergeRow(week, row)
  }

  const series = [...weeks.values()]
  const latest = [...series].reverse().find((week) => week.tvl > 0 || week.volume > 0 || week.fees > 0)
  const last7 = series.slice(-1)[0]
  const last30 = series.slice(-5)
  const rivals = input.share.flatMap((row): DuneRival[] => {
    const name = rowText(row, NAME_KEYS)
    const volume24h = rowNumber(row, VOL24_KEYS)
    if (!name || volume24h === undefined) return []
    return [{ name, volume24h, volume7d: rowNumber(row, ['volume7d', 'volume_7d']) ?? 0, fees24h: rowNumber(row, ['fees24h', 'fees_24h']) ?? 0, tvl: rowNumber(row, TVL_KEYS) ?? 0 }]
  }).sort((left, right) => right.volume24h - left.volume24h)

  const aero = rivals.filter((rival) => /aerodrome/i.test(rival.name))
  const baseVolume24h = rivals.reduce((sum, rival) => sum + rival.volume24h, 0)
  const aeroVolume = aero.reduce((sum, rival) => sum + rival.volume24h, 0)
  const rpv = parseRpvLeaders(input.rpv ?? [])

  return {
    source: 'Dune Analytics',
    chain: 'base',
    queries: AERO_QUERIES,
    executedAt: input.endedAt,
    tvlNow: latest?.tvl || undefined,
    fees24h: last7?.fees || undefined,
    fees7d: last7?.fees || undefined,
    fees30d: last30.reduce((sum, week) => sum + week.fees, 0) || undefined,
    volume24h: aeroVolume || last7?.volume || undefined,
    volume7d: last7?.volume || undefined,
    holdersRevenue24h: last7 ? last7.holders || (last7.fees + last7.bribes) || undefined : undefined,
    holdersRevenue7d: last7 ? last7.holders || (last7.fees + last7.bribes) || undefined : undefined,
    weeks: series,
    rivals,
    rpvLeaders: rpv.leaders,
    rpvEpoch: rpv.epoch,
    baseVolume24h,
    baseShare24h: baseVolume24h > 0 && aeroVolume > 0 ? aeroVolume / baseVolume24h : undefined,
  }
}

async function duneGet(path: string, key: string): Promise<SugarJson> {
  const response = await fetch(`https://api.dune.com/api${path}`, {
    headers: { 'X-Dune-API-Key': key },
    signal: AbortSignal.timeout(20_000),
  })
  const body = toSugarJson(await response.json())
  if (!response.ok) {
    const record = jsonRecord(body)
    const message = jsonString(record?.error) ?? jsonString(record?.message) ?? `HTTP ${response.status}`
    throw new Error(`Dune Analytics ${message}`)
  }
  return body
}

async function dunePost(path: string, key: string, payload: { sql: string; performance: string }): Promise<SugarJson> {
  const response = await fetch(`https://api.dune.com/api${path}`, {
    method: 'POST',
    headers: { 'X-Dune-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  })
  const body = toSugarJson(await response.json())
  if (!response.ok) {
    const record = jsonRecord(body)
    const message = jsonString(record?.error) ?? jsonString(record?.message) ?? `HTTP ${response.status}`
    throw new Error(`Dune Analytics ${message}`)
  }
  return body
}

const SHARE_SQL = `
SELECT
  CASE
    WHEN lower(project) LIKE 'aerodrome%' THEN 'Aerodrome'
    WHEN lower(project) LIKE 'uniswap%' THEN 'Uniswap'
    WHEN lower(project) LIKE 'pancake%' THEN 'PancakeSwap'
    ELSE project
  END AS name,
  SUM(amount_usd) AS volume24h
FROM dex.trades
WHERE blockchain = 'base'
  AND block_time >= NOW() - INTERVAL '1' DAY
  AND amount_usd IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC
LIMIT 12
`

const WEEKLY_SQL = `
SELECT
  CAST(to_unixtime(date_trunc('week', block_time)) AS bigint) AS ts,
  SUM(amount_usd) AS volume
FROM dex.trades
WHERE blockchain = 'base'
  AND lower(project) LIKE 'aerodrome%'
  AND block_time >= NOW() - INTERVAL '112' DAY
  AND amount_usd IS NOT NULL
GROUP BY 1
ORDER BY 1
`

async function executeSql(key: string, sql: string): Promise<DuneRow[]> {
  const started = await dunePost('/v1/sql/execute', key, { sql, performance: 'medium' })
  const executionId = jsonString(jsonRecord(started)?.execution_id)
  if (!executionId) throw new Error('Dune SQL execute returned no execution_id')
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const raw = await duneGet(`/v1/execution/${executionId}/results?limit=50`, key)
    const record = jsonRecord(raw)
    const state = jsonString(record?.state)
    if (state === 'QUERY_STATE_COMPLETED') return parseDuneResults(raw).rows
    if (state === 'QUERY_STATE_FAILED' || state === 'QUERY_STATE_CANCELLED') {
      const detail = jsonString(record?.error) ?? jsonString(jsonRecord(record?.error ?? null)?.message)
      throw new Error(detail ?? `Dune SQL ${state}`)
    }
    await Bun.sleep(1_500)
  }
  throw new Error('Dune SQL timed out')
}

const duneCache = new Map<number, { expiresAt: number; promise: Promise<DuneSnapshot | undefined> }>()
const DUNE_TTL_MS = 5 * 60_000

export function fetchDune(chainId: number, fresh = false): Promise<DuneSnapshot | undefined> {
  const cached = duneCache.get(chainId)
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.promise
  const promise = loadDune(chainId)
  duneCache.set(chainId, { expiresAt: Date.now() + DUNE_TTL_MS, promise })
  promise.catch(() => duneCache.delete(chainId))
  return promise
}

async function latestQuery(id: number, key: string, search = ''): Promise<DuneParsedResults> {
  try {
    return parseDuneResults(await duneGet(`/v1/query/${id}/results?limit=80${search}`, key))
  } catch (cause) {
    return { rows: [], error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export async function loadDune(chainId: number, env: Record<string, string | undefined> = process.env): Promise<DuneSnapshot | undefined> {
  if (chainId !== 8453) return undefined
  const key = duneApiKey(env)
  if (!key) return undefined
  const [rpv, share, weekly] = await Promise.all([
    latestQuery(DUNE_AERO_RPV.id, key, '&filters=is_partial = false&sort_by=e desc'),
    executeSql(key, SHARE_SQL).catch((): DuneRow[] => []),
    executeSql(key, WEEKLY_SQL).catch((): DuneRow[] => []),
  ])
  if (rpv.error && share.length === 0 && weekly.length === 0) throw new Error(rpv.error)
  return assembleDune({
    weekly,
    share,
    rpv: rpv.rows,
    endedAt: rpv.endedAt,
  })
}
