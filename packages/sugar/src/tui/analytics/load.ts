import { abis } from '../../abis'
import { SugarClient } from '../../client'
import { getChainSettings } from '../../config'
import { readSnapshot, writeSnapshot } from '../snapshot'
import { cacheStore, tuiExecution } from '../sugar-runtime'
import { duneApiKey, fetchDune, type DuneSnapshot } from './dune'
import { fetchLlama, type LlamaSnapshot } from './llama'
import { buildOnchainAnalytics, type OnchainAnalytics } from './metrics'

export type VeStats = {
  symbol: string
  price: number
  locked: number
  votingPower: number
  tokenSupply: number
  lockRate: number
  nftCount: number
}

export type AnalyticsReport = {
  chain: number
  chainName: string
  loadedAt: number
  onchain?: OnchainAnalytics
  dune?: DuneSnapshot
  llama?: LlamaSnapshot
  ve?: VeStats
  errors: string[]
}

function asWei(value: bigint): number {
  return Number(value) / 1e18
}

export async function fetchVeStats(client: SugarClient): Promise<VeStats | undefined> {
  if (!client.supportsVeNfts() || !client.settings.tokenAddress) return undefined
  const contracts = await client.getVeNftContracts()
  const token = await client.getToken(client.settings.tokenAddress)
  const [lockedRaw, votingRaw, nftRaw, supplyRaw] = await Promise.all([
    client.publicClient.readContract({ address: contracts.votingEscrow, abi: abis.votingEscrow, functionName: 'supply' }),
    client.publicClient.readContract({ address: contracts.votingEscrow, abi: abis.votingEscrow, functionName: 'totalSupply' }),
    client.publicClient.readContract({ address: contracts.votingEscrow, abi: abis.votingEscrow, functionName: 'tokenId' }),
    client.publicClient.readContract({ address: client.settings.tokenAddress, abi: abis.erc20, functionName: 'totalSupply' }),
  ])
  const prices = token ? await client.getPrices([token]) : []
  // SAFETY: VotingEscrow.supply is uint256; viem's JSON ABI types the decoded result as unknown.
  const locked = asWei(lockedRaw as bigint)
  // SAFETY: VotingEscrow.totalSupply is uint256 voting power.
  const votingPower = asWei(votingRaw as bigint)
  // SAFETY: AERO/VELO ERC20.totalSupply is uint256.
  const tokenSupply = asWei(supplyRaw as bigint)
  return {
    symbol: token?.symbol ?? 'AERO',
    price: prices[0]?.price ?? 0,
    locked,
    votingPower,
    tokenSupply,
    lockRate: tokenSupply > 0 ? locked / tokenSupply : 0,
    // SAFETY: VotingEscrow.tokenId is the last minted uint256 id.
    nftCount: Number(nftRaw as bigint),
  }
}

export async function loadOnchain(chain: number): Promise<{ onchain: OnchainAnalytics; ve?: VeStats }> {
  const client = new SugarClient(chain, { cacheStore, settings: tuiExecution.settings, onRpcEvent: tuiExecution.onRpcEvent })
  const [pools, epochs] = await Promise.all([
    client.getPools(),
    client.getLatestPoolEpochs(),
  ])
  const onchain = buildOnchainAnalytics(pools, epochs)
  let ve: VeStats | undefined
  try {
    ve = await fetchVeStats(client)
  } catch {
    ve = undefined
  }
  if (ve && onchain.aeroPrice === 0 && ve.price > 0) onchain.aeroPrice = ve.price
  return { onchain, ve }
}

export async function loadAnalytics(
  chain: number,
  onUpdate?: (report: AnalyticsReport) => void,
): Promise<AnalyticsReport> {
  const report: AnalyticsReport = {
    chain,
    chainName: getChainSettings(chain).chainName,
    loadedAt: Date.now(),
    errors: [],
  }
  const publish = () => onUpdate?.({ ...report, errors: [...report.errors] })

  const duneTask = fetchDune(chain).then((dune) => {
    report.dune = dune
    if (!dune && chain === 8453 && !duneApiKey()) {
      report.errors.push('Set DUNE_API_KEY to load Dune Analytics')
    }
    publish()
  }).catch((cause: unknown) => {
    report.errors.push(`Dune: ${cause instanceof Error ? cause.message : String(cause)}`)
    publish()
  })

  const llamaTask = fetchLlama(chain).then((llama) => {
    report.llama = llama
    publish()
  }).catch((cause: unknown) => {
    report.errors.push(`DefiLlama: ${cause instanceof Error ? cause.message : String(cause)}`)
    publish()
  })

  const chainTask = loadOnchain(chain).then((loaded) => {
    report.onchain = loaded.onchain
    report.ve = loaded.ve
    publish()
  }).catch((cause: unknown) => {
    report.errors.push(`Sugar: ${cause instanceof Error ? cause.message : String(cause)}`)
    publish()
  })

  await Promise.all([duneTask, llamaTask, chainTask])
  report.loadedAt = Date.now()
  return report
}

/**
 * Session-wide SWR layer over loadAnalytics: screens mount constantly
 * (tab flips, back-navigation) and each mount used to restart the full
 * Sugar+Dune+Llama sweep. One in-flight load per chain is shared, and a
 * settled report replays instantly until the TTL expires.
 */
const REPORT_TTL_MS = 60_000
const sharedReports = new Map<number, { report?: AnalyticsReport; promise?: Promise<AnalyticsReport>; startedAt: number }>()

const reportSnapshotKey = (chain: number) => `analytics:${chain}`

/** Last finished report from a previous TUI session; loadedAt stays honest. */
function readReportSnapshot(chain: number): AnalyticsReport | undefined {
  return readSnapshot<AnalyticsReport>(reportSnapshotKey(chain))?.data
}

export function peekReport(chain: number): AnalyticsReport | undefined {
  return sharedReports.get(chain)?.report ?? readReportSnapshot(chain)
}

export function loadAnalyticsShared(
  chain: number,
  onUpdate?: (report: AnalyticsReport) => void,
): Promise<AnalyticsReport> {
  const entry = sharedReports.get(chain)
  if (entry && entry.promise && Date.now() - entry.startedAt < REPORT_TTL_MS) {
    if (entry.report) onUpdate?.(entry.report)
    return entry.promise
  }
  const startedAt = Date.now()
  // Disk tier: a report persisted by a previous session renders instantly
  // while the fresh Sugar+Dune+Llama sweep replaces it below. Partial fresh
  // publishes keep the disk sections they have not superseded yet, so the
  // screen never downgrades from a complete (old) report to a sparse one.
  const disk = entry?.report ? undefined : readReportSnapshot(chain)
  let latest: AnalyticsReport | undefined = entry?.report ?? disk
  if (disk) onUpdate?.(disk)
  const promise = loadAnalytics(chain, (snapshot) => {
    const merged = disk
      ? {
        ...snapshot,
        onchain: snapshot.onchain ?? disk.onchain,
        dune: snapshot.dune ?? disk.dune,
        llama: snapshot.llama ?? disk.llama,
        ve: snapshot.ve ?? disk.ve,
      }
      : snapshot
    latest = merged
    onUpdate?.(merged)
  }).then((final) => {
    const current = sharedReports.get(chain)
    if (current && current.startedAt === startedAt) current.report = final
    else sharedReports.set(chain, { report: final, promise, startedAt })
    writeSnapshot(reportSnapshotKey(chain), final)
    return final
  }).catch((cause: unknown) => {
    const current = sharedReports.get(chain)
    if (current && current.startedAt === startedAt) {
      // Keep partial data visible but drop the poisoned promise so retry works.
      current.promise = undefined
    }
    throw cause
  })
  sharedReports.set(chain, { report: latest, promise, startedAt })
  return promise
}

/** ctrl+r semantics: forget the cached report so the next load is cold. */
export function invalidateReport(chain: number): void {
  sharedReports.delete(chain)
}
