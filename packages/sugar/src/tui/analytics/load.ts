import { abis } from '../../abis'
import { createReportCache } from './report-cache'
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

const reportCache = createReportCache({
  load: loadAnalytics,
  read: chain => readSnapshot<AnalyticsReport>(`analytics:${chain}`)?.data,
  write: (chain, report) => writeSnapshot(`analytics:${chain}`, report),
})

export const peekReport = reportCache.peek
export const loadAnalyticsShared = reportCache.load
export const invalidateReport = reportCache.invalidate
