import { toSugarJson } from '../../helpers'
import type { SugarJson } from '../../types'
import { jsonNumber, jsonRecord } from '../format'
import { rollupWeekly } from './metrics'

export type LlamaWeek = {
  ts: number
  fees: number
  holders: number
  volume: number
  tvl: number
  slipstreamFees: number
  legacyFees: number
}

export type LlamaSnapshot = {
  protocol: string
  chain: string
  mcap?: number
  tvlNow?: number
  fees24h?: number
  fees7d?: number
  fees30d?: number
  feesAllTime?: number
  volume24h?: number
  volume7d?: number
  holdersRevenue7d?: number
  weeks: LlamaWeek[]
}

type ChartPair = [number, number]
type LlamaSummary = { total24h?: number; total7d?: number; total30d?: number; totalAllTime?: number; chart: ChartPair[]; family: FamilyPoint[] }
type FamilyPoint = { ts: number; slipstream: number; legacy: number }
type LlamaTvl = { mcap?: number; tvl: ChartPair[] }

const EMPTY_SUMMARY: LlamaSummary = { chart: [], family: [] }
const EMPTY_TVL: LlamaTvl = { tvl: [] }
const WEEKS = 16

function jsonArray(value: SugarJson | undefined): SugarJson[] {
  return Array.isArray(value) ? value : []
}

function asChart(value: SugarJson | undefined): ChartPair[] {
  const pairs: ChartPair[] = []
  for (const row of jsonArray(value)) {
    if (!Array.isArray(row) || row.length < 2) continue
    const ts = jsonNumber(row[0])
    const amount = jsonNumber(row[1])
    if (ts === undefined || amount === undefined) continue
    pairs.push([ts, amount])
  }
  return pairs
}

function familyPoints(value: SugarJson | undefined): FamilyPoint[] {
  const points: FamilyPoint[] = []
  for (const row of jsonArray(value)) {
    if (!Array.isArray(row) || row.length < 2) continue
    const ts = jsonNumber(row[0])
    const chains = jsonRecord(row[1] ?? null)
    if (ts === undefined || !chains) continue
    let slipstream = 0
    let legacy = 0
    for (const inner of Object.values(chains)) {
      const amounts = jsonRecord(inner)
      if (!amounts) continue
      for (const [name, amount] of Object.entries(amounts)) {
        const value = jsonNumber(amount)
        if (value === undefined) continue
        if (/slipstream/i.test(name)) slipstream += value
        else legacy += value
      }
    }
    points.push({ ts, slipstream, legacy })
  }
  return points
}

export function parseSummary(raw: SugarJson): LlamaSummary {
  const record = jsonRecord(raw)
  if (!record) return EMPTY_SUMMARY
  return {
    total24h: jsonNumber(record.total24h),
    total7d: jsonNumber(record.total7d),
    total30d: jsonNumber(record.total30d),
    totalAllTime: jsonNumber(record.totalAllTime),
    chart: asChart(record.totalDataChart),
    family: familyPoints(record.totalDataChartBreakdown),
  }
}

export function parseProtocolTvl(raw: SugarJson): LlamaTvl {
  const record = jsonRecord(raw)
  if (!record) return EMPTY_TVL
  const tvl: ChartPair[] = []
  for (const row of jsonArray(record.tvl)) {
    const item = jsonRecord(row)
    if (!item) continue
    const ts = jsonNumber(item.date)
    const value = jsonNumber(item.totalLiquidityUSD)
    if (ts === undefined || value === undefined) continue
    tvl.push([ts, value])
  }
  return { mcap: jsonNumber(record.mcap), tvl }
}

function weeklyFamily(points: FamilyPoint[]): Map<number, FamilyPoint> {
  const map = new Map<number, FamilyPoint>()
  for (const point of points) {
    const week = point.ts - (point.ts % 604_800)
    const current = map.get(week) ?? { ts: week, slipstream: 0, legacy: 0 }
    current.slipstream += point.slipstream
    current.legacy += point.legacy
    map.set(week, current)
  }
  return map
}

export function assembleLlama(input: {
  protocol: string
  chain: string
  fees: LlamaSummary
  holders: LlamaSummary
  volume: LlamaSummary
  tvl: LlamaTvl
  now?: number
}): LlamaSnapshot {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const feesW = rollupWeekly(input.fees.chart, WEEKS, now)
  const holdersW = new Map(rollupWeekly(input.holders.chart, WEEKS, now).map((row) => [row.ts, row.value]))
  const volumeW = new Map(rollupWeekly(input.volume.chart, WEEKS, now).map((row) => [row.ts, row.value]))
  const tvlW = new Map(rollupWeekly(input.tvl.tvl, WEEKS, now, 'last').map((row) => [row.ts, row.value]))
  const feeFam = weeklyFamily(input.fees.family)
  const weeks = feesW.map((row) => ({
    ts: row.ts,
    fees: row.value,
    holders: holdersW.get(row.ts) ?? 0,
    volume: volumeW.get(row.ts) ?? 0,
    tvl: tvlW.get(row.ts) ?? 0,
    slipstreamFees: feeFam.get(row.ts)?.slipstream ?? 0,
    legacyFees: feeFam.get(row.ts)?.legacy ?? 0,
  }))
  const latestTvl = input.tvl.tvl[input.tvl.tvl.length - 1]
  return {
    protocol: input.protocol,
    chain: input.chain,
    mcap: input.tvl.mcap,
    tvlNow: weeks[weeks.length - 1]?.tvl || latestTvl?.[1],
    fees24h: input.fees.total24h,
    fees7d: input.fees.total7d,
    fees30d: input.fees.total30d,
    feesAllTime: input.fees.totalAllTime,
    volume24h: input.volume.total24h,
    volume7d: input.volume.total7d,
    holdersRevenue7d: input.holders.total7d,
    weeks,
  }
}

async function getJson(url: string): Promise<SugarJson> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`DefiLlama ${response.status}`)
  return toSugarJson(await response.json())
}

const llamaCache = new Map<number, { expiresAt: number; promise: Promise<LlamaSnapshot | undefined> }>()

export function fetchLlama(chainId: number, fresh = false): Promise<LlamaSnapshot | undefined> {
  const cached = llamaCache.get(chainId)
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.promise
  const promise = loadLlama(chainId)
  llamaCache.set(chainId, { expiresAt: Date.now() + 5 * 60_000, promise })
  promise.catch(() => llamaCache.delete(chainId))
  return promise
}

async function loadLlama(chainId: number): Promise<LlamaSnapshot | undefined> {
  const slug = chainId === 8453 ? 'aerodrome' : chainId === 10 ? 'velodrome' : undefined
  const chain = chainId === 8453 ? 'base' : chainId === 10 ? 'optimism' : undefined
  const protocol = chainId === 8453 ? 'Aerodrome' : chainId === 10 ? 'Velodrome' : undefined
  if (!slug || !chain || !protocol) return undefined
  const base = 'https://api.llama.fi'
  const [feesRaw, holdersRaw, volumeRaw, tvlRaw] = await Promise.all([
    getJson(`${base}/summary/fees/${slug}`),
    getJson(`${base}/summary/fees/${slug}?dataType=dailyHoldersRevenue`),
    getJson(`${base}/summary/dexs/${slug}`),
    getJson(`${base}/protocol/${slug}`),
  ])
  return assembleLlama({
    protocol,
    chain,
    fees: parseSummary(feesRaw),
    holders: parseSummary(holdersRaw),
    volume: parseSummary(volumeRaw),
    tvl: parseProtocolTvl(tvlRaw),
  })
}

export function llamaProtocolUrl(chainId: number): string | undefined {
  if (chainId === 8453) return 'https://defillama.com/protocol/aerodrome'
  if (chainId === 10) return 'https://defillama.com/protocol/velodrome'
  return undefined
}
