import * as Effect from 'effect/Effect'
import { abis } from '../abis'
import type { SugarRpcError } from '../errors'
import type { SugarContext } from './context'
import { clientCall, runSugar } from './interop'
import type { RpcDeadline, RpcReadTask } from './rpc-executor'

const MAX_PAGINATION_REQUESTS = 10_000

export function pageSize(ctx: SugarContext, poolCount: number): number {
  if (!Number.isSafeInteger(poolCount) || poolCount < 0) {
    throw new RangeError('Sugar pool count must be a safe non-negative integer')
  }
  const minimum = ctx.settings.poolPaginationMinSize
  const maximum = ctx.settings.poolPaginationMaxSize
  const targetCalls = ctx.settings.poolPaginationTargetCalls
  if (![minimum, maximum, targetCalls].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Sugar pagination settings must be positive safe integers')
  }
  if (minimum > maximum) {
    throw new RangeError('Sugar pagination minimum cannot exceed maximum')
  }
  return Math.max(minimum, Math.min(Math.floor(poolCount / targetCalls), maximum))
}

export function getPoolPaginator(ctx: SugarContext, poolCount: number): Array<{ offset: number; limit: number }> {
  return [...poolPageRequests(ctx, poolCount)]
}

export function* poolPageRequests(
  ctx: SugarContext,
  poolCount: number,
  requestedLimit?: number,
): Generator<{ offset: number; limit: number }> {
  const defaultLimit = pageSize(ctx, poolCount)
  const limit = requestedLimit ?? defaultLimit
  if (
    !Number.isSafeInteger(limit)
    || limit <= 0
    || limit > ctx.settings.poolPaginationMaxSize
  ) {
    throw new RangeError(
      `Sugar pagination limit must be a positive safe integer no greater than ${ctx.settings.poolPaginationMaxSize}`,
    )
  }
  const pageCount = Math.ceil((poolCount + 10) / limit)
  if (!Number.isSafeInteger(pageCount) || pageCount > MAX_PAGINATION_REQUESTS) {
    throw new RangeError(`Sugar pagination allows at most ${MAX_PAGINATION_REQUESTS} requests`)
  }
  for (let page = 0; page < pageCount; page++) yield { offset: page * limit, limit }
}

export const paginate = Effect.fn('Sugar.Pagination.paginate')(function* <T>(
  ctx: SugarContext,
  operation: string,
  reader: (limit: number, offset: number) => RpcReadTask<T[]>,
  requestedDeadline?: RpcDeadline,
  pageLimit?: number,
) {
  const deadline = requestedDeadline ?? ctx.rpc.deadline(operation)
  const startedAt = Date.now()
  let pageCount = 0
  const event = (status: 'error' | 'success', itemCount: number) => ({
    attemptCount: deadline.attempts,
    durationMs: Date.now() - startedAt,
    itemCount,
    operation,
    pageCount,
    phase: 'pagination' as const,
    status,
  })
  const pages = yield* Effect.gen(function* () {
    const count = yield* getPoolCountWithin(ctx, deadline)
    const requests = pageLimit === undefined
      ? getPoolPaginator(ctx, count)
      : [...poolPageRequests(ctx, count, pageLimit)]
    pageCount = requests.length
    return yield* ctx.rpc.forEachRead(
      operation,
      requests,
      ({ limit, offset }, _index, signal) => reader(limit, offset)(signal),
      ctx.settings.requestConcurrency,
      deadline,
    )
  }).pipe(
    Effect.tapCause(() => Effect.sync(() => ctx.emitRpcEvent(event('error', 0)))),
  )
  const results = pages.flat()
  ctx.emitRpcEvent(event('success', results.length))
  return results
})

/**
 * One deduplicated pool-count read shared by every pagination pass. The count
 * participates in the caller's deadline, a per-call argument that a keyed
 * cache lookup cannot carry, so this stays a promise slot cleared on failure.
 */
export function getPoolCountWithin(ctx: SugarContext, deadline: RpcDeadline): Effect.Effect<number, SugarRpcError> {
  return Effect.suspend(() => {
    if (!ctx.caches.poolCountCache || (ctx.caches.poolCountExpiresAt ?? 0) <= Date.now()) {
      const promise = runSugar(readPoolCount(ctx, deadline))
      ctx.caches.poolCountCache = promise
      ctx.caches.poolCountExpiresAt = Date.now() + (ctx.caches.ttlMs ?? 120_000)
      void promise.catch(() => {
        if (ctx.caches.poolCountCache === promise) ctx.caches.poolCountCache = undefined
      })
    }
    const pending = ctx.caches.poolCountCache
    return clientCall(() => pending)
  })
}

const readPoolCount = Effect.fn('Sugar.Pagination.readPoolCount')(function* (
  ctx: SugarContext,
  deadline: RpcDeadline,
) {
  const rawCount = yield* ctx.read<bigint>(
    ctx.settings.sugarContractAddress,
    abis.sugar,
    'count',
    undefined,
    deadline,
  )
  const count = Number(rawCount)
  if (rawCount < 0n || !Number.isSafeInteger(count)) {
    throw new RangeError('Sugar pool count must be a safe non-negative integer')
  }
  return count
})

export function getPoolCount(ctx: SugarContext): Effect.Effect<number, SugarRpcError> {
  return Effect.suspend(() => getPoolCountWithin(ctx, ctx.rpc.deadline('count')))
}
