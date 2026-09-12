import { fallback, http, type Transport } from 'viem'
import { isTransientRpcFailure } from './internal/rpc-executor'
import type { SugarRpcEvent, SugarRpcObserver } from './types'

export type SugarFailoverTransportOptions = {
  /** Per-attempt HTTP timeout for each endpoint. */
  timeoutMs?: number
  /** Minimum delay between request starts across all endpoints. */
  minIntervalMs?: number
  /** Optional low-cardinality telemetry callback. URLs and parameters are omitted. */
  onRpcEvent?: SugarRpcObserver
}

export class SugarRpcConsistencyError extends Error {
  override readonly name = 'SugarRpcConsistencyError'

  constructor(cause: unknown) {
    super('RPC endpoints disagreed after failover; retrying on a consistent endpoint', {
      cause,
    })
  }
}

const STALE_STATE_REVERT =
  /insufficient (?:allowance|balance)|transfer amount exceeds balance|nonce too low/i

function emitRpcEvent(observer: SugarRpcObserver | undefined, event: SugarRpcEvent): void {
  try {
    observer?.(event)
  } catch {
    // Observability must never alter transport behavior.
  }
}

/**
 * A transport that fails over to backup RPC endpoints only for transient
 * failures (throttling, outages, timeouts). Deterministic errors such as
 * contract reverts throw immediately: Viem's default fallback would replay
 * them across every endpoint and multiply quoter latency, since quoter
 * reads revert by design for unusable paths. Viem-level retries stay off so
 * the Sugar RPC policy remains the single retry authority.
 */
export function createSugarFailoverTransport(
  rpcUrls: readonly string[],
  options: SugarFailoverTransportOptions = {},
): Transport {
  if (rpcUrls.length === 0) {
    throw new Error('createSugarFailoverTransport requires at least one RPC URL')
  }
  const minIntervalMs = options.minIntervalMs ?? 0
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error('minIntervalMs must be a non-negative finite number')
  }
  let requestQueue = Promise.resolve()
  let nextRequestAt = 0
  const pace = <A>(task: () => Promise<A>): Promise<A> => {
    if (minIntervalMs === 0) return task()
    const start = requestQueue.then(async () => {
      const delayMs = Math.max(0, nextRequestAt - Date.now())
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
      nextRequestAt = Date.now() + minIntervalMs
    })
    requestQueue = start.then(() => undefined, () => undefined)
    return start.then(task)
  }
  const httpOptions = { retryCount: 0, timeout: options.timeoutMs ?? 30_000 }
  const transport = fallback(
    rpcUrls.map((url, index) => http(url, { ...httpOptions, key: `sugar-rpc-${index}` })),
    {
      retryCount: 0,
      shouldThrow: (error) => !isTransientRpcFailure(error),
    },
  )
  // SAFETY: the wrapper returns fallback()'s configured transport unchanged apart from request pacing and telemetry hooks, so the Transport contract is preserved.
  return ((parameters) => {
    const configured = transport(parameters)
    configured.value?.onResponse(({ method, status, transport: attemptedTransport }) => {
      const endpointIndex = Number(attemptedTransport.config.key.replace('sugar-rpc-', ''))
      emitRpcEvent(options.onRpcEvent, {
        attemptCount: endpointIndex + 1,
        failoverUsed: endpointIndex > 0,
        operation: method,
        phase: 'transport',
        status,
      })
    })
    const request = configured.request
    configured.request = async (requestParameters) => {
      try {
        return await pace(() => request(requestParameters))
      } catch (error) {
        if (
          rpcUrls.length > 1 &&
          STALE_STATE_REVERT.test(
            error instanceof Error ? error.message : String(error),
          )
        ) {
          throw new SugarRpcConsistencyError(error)
        }
        throw error
      }
    }
    return configured
  }) as Transport
}
