import { executeSugarAction, type SugarExecutionOptions } from '../actions'
import { createSugarCacheStore } from '../cache'
import { SugarClient } from '../client'
import { isSugarTxAction, type SugarAction, type SugarParameters } from '../contracts'
import * as Effect from 'effect/Effect'
import { dedupeTokens, loadTokenCatalog, setTokenCatalogClientFactory } from '../token-catalog'
import { readSnapshot, writeSnapshot } from './snapshot'
import type { ChainSettings, SugarJson, SugarRpcObserver, Token } from '../types'
import { POOLS_BROWSE_PARAMETERS } from './worker-protocol'

/**
 * One cache store for the whole TUI session: token catalogs and pool lists
 * are fetched once per chain (within the store TTL) and shared by every
 * action, instead of every keystroke paying the full catalog scan that a
 * fresh SugarClient would trigger.
 *
 * Quote tuning trades route exhaustiveness for latency: the headless CLI
 * keeps the default 3000 candidate paths in batches of 64, while the
 * interactive TUI quotes the 128 shortest ones in four light multicalls
 * (one concurrent wave, ~110ms measured on the public Base RPC with an
 * identical best route). Shortest paths carry nearly all real liquidity —
 * the SDK's own pruning prefers them. Longer price caching only affects
 * advisory USD context, never quoted amounts. Each tune is skipped when
 * the matching SUGAR_* env var is set, since settings overrides beat env.
 */
export const cacheStore = createSugarCacheStore()

const envPinned = (prefix: string) => Object.keys(process.env).some((name) => name.startsWith(prefix))

/**
 * The default concurrency of 5 exists to survive public-RPC rate limits.
 * A user who pinned their own endpoint (SUGAR_RPC_URI*) has real headroom,
 * so the paginated scans fan out harder and warming runs in parallel.
 */
const hasCustomRpc = envPinned('SUGAR_RPC_URI')

const tunedSettings: Partial<ChainSettings> = {}
if (!envPinned('SUGAR_QUOTE_MAX_PATHS')) tunedSettings.quoteMaxPaths = 128
if (!envPinned('SUGAR_QUOTE_BATCH_SIZE')) tunedSettings.quoteBatchSize = 32
if (!envPinned('SUGAR_PRICING_CACHE_TIMEOUT_SECONDS')) tunedSettings.pricingCacheTimeoutSeconds = 30
if (hasCustomRpc && !envPinned('SUGAR_THREADING_MAX_WORKERS')) tunedSettings.requestConcurrency = 16

/**
 * Session-wide RPC activity counter feeding the loading spinners, so a long
 * chain scan shows visible progress instead of a silent spinner.
 */
let rpcReadCount = 0
const rpcActivityListeners = new Set<() => void>()

const recordRpcEvent: SugarRpcObserver = (event) => {
  if (event.phase !== 'read' || event.status !== 'success') return
  rpcReadCount += 1
  for (const listener of rpcActivityListeners) listener()
}

export function tuiRpcReadCount(): number {
  return rpcReadCount
}

export function subscribeTuiRpcActivity(listener: () => void): () => void {
  rpcActivityListeners.add(listener)
  return () => rpcActivityListeners.delete(listener)
}

export const tuiExecution: SugarExecutionOptions = {
  cacheStore,
  settings: tunedSettings,
  onRpcEvent: recordRpcEvent,
}

/**
 * Prefetched read results keyed by action + parameters. Screens consume an
 * in-flight or fresh entry instead of paying the scan again; entries expire
 * quickly because positions and epochs change with every transaction.
 */
const PREFETCH_TTL_MS = 60_000
type PrefetchEntry = {
  promise: Promise<SugarJson>
  status: { kind: 'pending' } | { kind: 'ready'; expiresAt: number }
}
const prefetched = new Map<string, PrefetchEntry>()

function reusable(entry: PrefetchEntry | undefined, fresh = false): entry is PrefetchEntry {
  return entry !== undefined && (entry.status.kind === 'pending' || (!fresh && entry.status.expiresAt > Date.now()))
}

/**
 * Read results worth persisting across TUI launches. Deliberately only the
 * browse/analytics datasets — anything feeding quotes or transaction
 * building must always come from live chain state.
 */
const SNAPSHOT_ACTIONS: ReadonlySet<SugarAction> = new Set(['pools', 'epochs_latest', 'positions'])

function prefetchKey(action: SugarAction, parameters: SugarParameters): string {
  const sorted = Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)))
  return `${action}:${JSON.stringify(sorted)}`
}

/** Start (and register) a live fetch; successes also refresh the disk snapshot. */
function fetchTuiAction(key: string, action: SugarAction, parameters: SugarParameters, fresh = false): Promise<SugarJson> {
  const promise = fresh
    ? Promise.resolve(cacheStore.invalidate?.()).then(() => executeSugarAction(action, parameters, tuiExecution))
    : executeSugarAction(action, parameters, tuiExecution)
  const entry: PrefetchEntry = { promise, status: { kind: 'pending' } }
  prefetched.set(key, entry)
  promise
    .then((data) => {
      if (prefetched.get(key) !== entry) return
      entry.status = { kind: 'ready', expiresAt: Date.now() + PREFETCH_TTL_MS }
      if (SNAPSHOT_ACTIONS.has(action)) writeSnapshot(key, data)
    })
    .catch(() => {
      if (prefetched.get(key) === entry) prefetched.delete(key)
    })
  return promise
}

export function prefetchTuiAction(action: SugarAction, parameters: SugarParameters): void {
  if (action === 'quote' || isSugarTxAction(action)) return
  const key = prefetchKey(action, parameters)
  const entry = prefetched.get(key)
  if (reusable(entry)) return
  void fetchTuiAction(key, action, parameters)
}

/** Run a read through the prefetch layer; `fresh` bypasses and refills it. */
export function runTuiAction(action: SugarAction, parameters: SugarParameters, options: { fresh?: boolean } = {}): Promise<SugarJson> {
  if (action === 'quote' || isSugarTxAction(action)) return executeSugarAction(action, parameters, tuiExecution)
  const key = prefetchKey(action, parameters)
  const entry = prefetched.get(key)
  if (reusable(entry, options.fresh)) return entry.promise
  prefetched.delete(key)
  return fetchTuiAction(key, action, parameters, options.fresh)
}

export type TuiActionUpdate = {
  data?: SugarJson
  /** Present when `data` came from (or still reflects) a disk snapshot. */
  savedAt?: number
  stale: boolean
  refreshing: boolean
  error?: unknown
}

/**
 * Stale-while-revalidate read for the browse screens: a persisted snapshot
 * (when one exists) is delivered synchronously so the screen renders
 * instantly, then the live result replaces it when the scan lands. Errors
 * after a snapshot emit keep the stale data visible instead of blanking
 * the screen.
 */
export function subscribeTuiAction(
  action: SugarAction,
  parameters: SugarParameters,
  listener: (update: TuiActionUpdate) => void,
  options: { fresh?: boolean } = {},
): () => void {
  let active = true
  const key = prefetchKey(action, parameters)
  const snapshot = SNAPSHOT_ACTIONS.has(action) ? readSnapshot<SugarJson>(key) : undefined
  if (snapshot) listener({ data: snapshot.data, savedAt: snapshot.savedAt, stale: true, refreshing: true })
  const pending = runTuiAction(action, parameters, options)
  pending
    .then((data) => {
      if (active) listener({ data, stale: false, refreshing: false })
    })
    .catch((cause: unknown) => {
      if (!active) return
      if (snapshot) listener({ data: snapshot.data, savedAt: snapshot.savedAt, stale: true, refreshing: false, error: cause })
      else listener({ stale: false, refreshing: false, error: cause })
    })
  return () => {
    active = false
  }
}

/** After a broadcast the chain state moved; stale prefetches must not survive it. */
export async function clearTuiPrefetch(): Promise<void> {
  prefetched.clear()
  await cacheStore.invalidate?.()
}

/**
 * Whitelisted token catalog for the form token pickers, shared process-wide
 * through the same cache as the CLI finder (one chain scan per session).
 *
 * The catalog client shares the TUI cache store, so its `tokens()` read
 * dedupes against the scan warmChain already paid instead of re-paginating
 * the chain. A disk snapshot serves the first picker open of a session
 * instantly (symbols and decimals barely move); the live scan refreshes it
 * in the background and wins once it has landed.
 */
setTokenCatalogClientFactory((chainId) => new SugarClient(chainId, { cacheStore, settings: tunedSettings, onRpcEvent: recordRpcEvent }))

const freshCatalogChains = new Set<number>()

export function tuiTokenCatalog(chainId: number): Promise<Token[]> {
  const key = `token_catalog:{"chain":${chainId}}`
  const refresh = Effect.runPromise(loadTokenCatalog(chainId))
  refresh
    .then((tokens) => {
      freshCatalogChains.add(chainId)
      writeSnapshot(key, tokens)
    })
    .catch(() => undefined)
  // Once a live scan has succeeded this session, the in-memory catalog cache
  // answers instantly and fresher than any snapshot.
  if (freshCatalogChains.has(chainId)) return refresh
  const snapshot = readSnapshot<Token[]>(key)
  // Dedupe on read too: snapshots written before catalog deduplication may
  // still carry the chain scan's repeated rows.
  return snapshot ? Promise.resolve(dedupeTokens(snapshot.data)) : refresh
}

/** Fire-and-forget: pre-populate caches and the slowest scans at TUI start. */
export function warmChain(chain: number, wallet?: string): void {
  const warm = async () => {
    const client = new SugarClient(chain, { cacheStore, settings: tunedSettings, onRpcEvent: recordRpcEvent })
    await client.getAllTokens()
    void tuiTokenCatalog(chain).catch(() => undefined)
    const warmPrices = async () => {
      const anchors = (await Promise.all([
        client.getToken(client.settings.nativeTokenSymbol),
        client.getToken(client.settings.stableTokenAddress),
      ])).filter((token): token is Token => token !== undefined)
      if (anchors.length > 0) await client.getPrices(anchors)
    }
    if (hasCustomRpc) {
      // A pinned endpoint tolerates the fan-out; scans share the cache store.
      await Promise.all([
        client.getPoolsForSwaps().then(warmPrices),
        client.getPools(),
      ])
    } else {
      // Sequential on purpose: public RPCs rate-limit aggressively, and the
      // quote path needs tokens + swap pools + prices first anyway.
      await client.getPoolsForSwaps()
      await warmPrices()
      await client.getPools()
    }
    // The heaviest uncached scans, warmed so their screens open instantly.
    prefetchTuiAction('pools', { chain, ...POOLS_BROWSE_PARAMETERS })
    prefetchTuiAction('epochs_latest', { chain })
    if (wallet) prefetchTuiAction('positions', { chain, wallet })
    if (chain === 8453 || chain === 10) {
      void import('./analytics/dune').then(({ fetchDune }) => fetchDune(chain)).catch(() => undefined)
      void import('./analytics/llama').then(({ fetchLlama }) => fetchLlama(chain)).catch(() => undefined)
    }
  }
  warm().catch(() => {
    // Warming is best-effort; the action itself will surface real errors.
  })
}
