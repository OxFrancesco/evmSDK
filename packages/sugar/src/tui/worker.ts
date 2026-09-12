import { invalidateReport, loadAnalyticsShared, peekReport } from './analytics/load'
import { fetchLlama } from './analytics/llama'
import { clearTuiPrefetch, prefetchTuiAction, runTuiAction, subscribeTuiAction, subscribeTuiRpcActivity, tuiTokenCatalog, warmChain } from './sugar-runtime'
import type { TuiWorkerMessage, TuiWorkerRequest, TuiWorkerResult } from './worker-protocol'

declare const self: Worker

const subscriptions = new Map<number, () => void>()
const send = (message: TuiWorkerMessage) => self.postMessage(message)
subscribeTuiRpcActivity(() => send({ kind: 'rpc' }))

async function execute(request: TuiWorkerRequest): Promise<TuiWorkerResult> {
  switch (request.kind) {
    case 'action':
      return { kind: 'action', data: await runTuiAction(request.action, request.parameters, { fresh: request.fresh }) }
    case 'tokens':
      return { kind: 'tokens', data: await tuiTokenCatalog(request.chain) }
    case 'llama':
      return { kind: 'llama', data: await fetchLlama(request.chain) }
    case 'analytics': {
      if (request.fresh) {
        invalidateReport(request.chain)
        await clearTuiPrefetch()
      }
      const saved = peekReport(request.chain)
      if (saved) send({ id: request.id, kind: 'analytics-update', report: saved })
      const data = await loadAnalyticsShared(request.chain, (report) => send({ id: request.id, kind: 'analytics-update', report }))
      return { kind: 'analytics', data }
    }
    case 'warm':
      warmChain(request.chain, request.wallet)
      return { kind: 'done' }
    case 'prefetch':
      prefetchTuiAction(request.action, request.parameters)
      return { kind: 'done' }
    case 'clear':
      await clearTuiPrefetch()
      return { kind: 'done' }
    case 'subscribe':
      return new Promise((resolve) => {
        const stop = subscribeTuiAction(request.action, request.parameters, (update) => {
          const error = update.error === undefined ? undefined
            : new Error(update.error instanceof Error ? update.error.message : String(update.error))
          send({ id: request.id, kind: 'action-update', update: { ...update, error } })
          if (!update.refreshing) {
            subscriptions.delete(request.id)
            resolve({ kind: 'done' })
          }
        }, { fresh: request.fresh })
        subscriptions.set(request.id, () => {
          stop()
          resolve({ kind: 'done' })
        })
      })
    case 'cancel':
      subscriptions.get(request.id)?.()
      subscriptions.delete(request.id)
      return { kind: 'done' }
  }
}

self.onmessage = ({ data }: MessageEvent<TuiWorkerRequest>) => {
  execute(data).then(
    (result) => send({ id: data.id, kind: 'result', result }),
    (cause: unknown) => send({ id: data.id, kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
  )
}
