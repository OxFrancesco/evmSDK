import type { SugarAction, SugarParameters } from '../contracts'
import type { SugarJson, Token } from '../types'
import type { AnalyticsReport } from './analytics/load'
import type { LlamaSnapshot } from './analytics/llama'
import type { TuiActionUpdate } from './sugar-runtime'
import { TuiWorkerClient } from './worker-client'

export type { TuiActionUpdate } from './sugar-runtime'

let rpcReadCount = 0
const rpcActivityListeners = new Set<() => void>()
const client = new TuiWorkerClient(undefined, () => {
  rpcReadCount += 1
  for (const listener of rpcActivityListeners) listener()
})

export { POOLS_BROWSE_PARAMETERS } from './worker-protocol'

export function tuiRpcReadCount(): number {
  return rpcReadCount
}

export function subscribeTuiRpcActivity(listener: () => void): () => void {
  rpcActivityListeners.add(listener)
  return () => rpcActivityListeners.delete(listener)
}

export async function runTuiAction(action: SugarAction, parameters: SugarParameters, options: { fresh?: boolean } = {}): Promise<SugarJson> {
  const result = await client.request({ kind: 'action', action, parameters, fresh: options.fresh }).promise
  if (result.kind !== 'action') throw new Error('Unexpected Aero action response')
  return result.data
}

export function prefetchTuiAction(action: SugarAction, parameters: SugarParameters): void {
  void client.request({ kind: 'prefetch', action, parameters }).promise.catch(() => undefined)
}

export function subscribeTuiAction(
  action: SugarAction,
  parameters: SugarParameters,
  listener: (update: TuiActionUpdate) => void,
  options: { fresh?: boolean } = {},
): () => void {
  let active = true
  let latest: TuiActionUpdate = { stale: false, refreshing: true }
  const pending = client.request({ kind: 'subscribe', action, parameters, fresh: options.fresh }, (message) => {
    if (active && message.kind === 'action-update') {
      latest = message.update
      listener(latest)
    }
  })
  pending.promise.catch((error: Error) => {
    if (active) listener({ ...latest, refreshing: false, error })
  })
  return () => {
    active = false
    pending.cancel()
  }
}

export async function clearTuiPrefetch(): Promise<void> {
  await client.request({ kind: 'clear' }).promise
}

export async function tuiTokenCatalog(chain: number): Promise<Token[]> {
  const result = await client.request({ kind: 'tokens', chain }).promise
  if (result.kind !== 'tokens') throw new Error('Unexpected Aero token response')
  return result.data
}

export function warmChain(chain: number, wallet?: string): void {
  void client.request({ kind: 'warm', chain, wallet }).promise.catch(() => undefined)
}

export async function fetchTuiLlama(chain: number): Promise<LlamaSnapshot | undefined> {
  const result = await client.request({ kind: 'llama', chain }).promise
  if (result.kind !== 'llama') throw new Error('Unexpected Aero stats response')
  return result.data
}

export async function loadTuiAnalytics(chain: number, onUpdate: (report: AnalyticsReport) => void, fresh = false): Promise<AnalyticsReport> {
  const result = await client.request({ kind: 'analytics', chain, fresh }, (message) => {
    if (message.kind === 'analytics-update') onUpdate(message.report)
  }).promise
  if (result.kind !== 'analytics') throw new Error('Unexpected Aero analytics response')
  return result.data
}

export function stopTuiWorker(): void {
  client.stop()
}
