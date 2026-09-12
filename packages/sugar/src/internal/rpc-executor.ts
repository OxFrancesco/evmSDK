import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Schedule from 'effect/Schedule'
import { SugarRpcError, type SugarRpcErrorCode } from '../errors'
import type { SugarRpcEvent, SugarRpcObserver, SugarRpcPolicyOptions } from '../types'

export type RpcReadTask<A> = (signal: AbortSignal) => PromiseLike<A>

type RpcPolicy = Readonly<{
  baseDelayMs: number
  deadlineMs: number
  maxRetries: number
}>

export type RpcDeadline = {
  readonly deadlineMs: number
  readonly expiresAt: number
  readonly operation: string
  attempts: number
  readonly pendingCauses: Map<symbol, unknown>
}

export type RpcReadResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly error: SugarRpcError; readonly ok: false }

/** Internal control-flow failure carrying the Retry-After hint for the schedule. */
class RpcAttemptFailure extends Data.TaggedError('RpcAttemptFailure')<{
  readonly error: SugarRpcError
  readonly retryAfterMs: number
}> {}

class RpcDeadlineFailure extends Data.TaggedError('RpcDeadlineFailure')<{
  readonly attempts: number
  readonly cause: unknown
  readonly deadlineMs: number
  readonly operation: string
}> {}

const HTTP_RETRY_STATUSES = new Set([403, 408, 413, 429, 500, 502, 503, 504])
const RPC_RETRY_CODES = new Set([-1, -32_603, -32_005, -32_002])
const TRANSPORT_ERROR_NAMES = new Set([
  'ChainDisconnectedError',
  'HttpRequestError',
  'ProviderDisconnectedError',
  'SocketClosedError',
  'TimeoutError',
  'WebSocketRequestError',
  'SugarRpcConsistencyError',
])

function errorChain(cause: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current = cause
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    if (!Predicate.isObject(current) || !('cause' in current)) break
    current = current.cause
  }
  return chain
}

function numericField(cause: unknown, field: 'code' | 'status'): number | undefined {
  if (!Predicate.isObject(cause) || !(field in cause)) return undefined
  const fieldValue = cause[field]
  return Predicate.isNumber(fieldValue) ? fieldValue : undefined
}

function errorName(cause: unknown): string | undefined {
  return Predicate.isObject(cause) && 'name' in cause && Predicate.isString(cause.name)
    ? cause.name
    : undefined
}

/** URL-redacted, low-cardinality view of an RPC failure safe to expose. */
type PublicRpcCause = {
  message: string
  code?: number
  name?: string
  status?: number
}

function publicRpcCause(cause: unknown): Readonly<PublicRpcCause> {
  const status = numericField(cause, 'status')
  const code = numericField(cause, 'code')
  const name = errorName(cause)
  const message = Predicate.isObject(cause) && 'message' in cause && Predicate.isString(cause.message)
    ? cause.message.replace(
        /(https?:\/\/[^/\s]+\/(?:v2|v3)\/)[^/\s)"']+/gi,
        '$1[REDACTED]',
      )
    : 'RPC request failed'
  const publicCause: PublicRpcCause = { message }
  if (code !== undefined) publicCause.code = code
  if (name !== undefined) publicCause.name = name
  if (status !== undefined) publicCause.status = status
  return Object.freeze(publicCause)
}

/** Whether a failure is transient (throttling, outage, timeout) rather than deterministic. */
export function isTransientRpcFailure(cause: unknown): boolean {
  return classifyRpcError(cause).retryable
}

type RpcClassification = { code: SugarRpcErrorCode; retryable: boolean }

function classifyRpcError(cause: unknown): RpcClassification {
  const chain = errorChain(cause)
  if (chain.some((error) => errorName(error) === 'ContractFunctionRevertedError')) {
    return { code: 'RPC_READ_FAILED', retryable: false }
  }

  for (const error of chain) {
    const status = numericField(error, 'status')
    const code = numericField(error, 'code')
    const name = errorName(error)
    if (status === 429 || code === -32_005) return { code: 'RPC_RATE_LIMITED', retryable: true }
    if (name === 'TimeoutError' || name === 'AbortError') return { code: 'RPC_TIMEOUT', retryable: true }
    if ((status !== undefined && HTTP_RETRY_STATUSES.has(status)) || (code !== undefined && RPC_RETRY_CODES.has(code))) {
      return { code: 'RPC_UNAVAILABLE', retryable: true }
    }
    if (name && TRANSPORT_ERROR_NAMES.has(name)) return { code: 'RPC_UNAVAILABLE', retryable: true }
  }
  return { code: 'RPC_READ_FAILED', retryable: false }
}

function getRetryAfterMs(cause: unknown): number {
  for (const error of errorChain(cause)) {
    if (!Predicate.isObject(error) || !('headers' in error)) continue
    const headers = error.headers
    if (!Predicate.isObject(headers) || !('get' in headers) || !Predicate.isFunction(headers.get)) continue
    const value = headers.get('Retry-After')
    if (!Predicate.isString(value) || value.trim() === '') continue
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
    const at = Date.parse(value)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  return 0
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function emitRpcEvent(observer: SugarRpcObserver | undefined, event: SugarRpcEvent): void {
  try {
    observer?.(event)
  } catch {
    // Observability must never alter an RPC result.
  }
}

function resolveRpcPolicy(options: SugarRpcPolicyOptions = {}): RpcPolicy {
  return {
    baseDelayMs: nonNegativeInteger(options.baseDelayMs ?? 150, 'rpcPolicy.baseDelayMs'),
    deadlineMs: positiveInteger(options.deadlineMs ?? 120_000, 'rpcPolicy.deadlineMs'),
    maxRetries: nonNegativeInteger(options.maxRetries ?? 3, 'rpcPolicy.maxRetries'),
  }
}

/**
 * Exponential backoff bounded by maxRetries; a provider Retry-After hint
 * stretches (never shortens) the computed delay. Only transient failures
 * recur — deterministic reverts fail fast via the retry `while` predicate.
 */
function retrySchedule(policy: RpcPolicy) {
  return Schedule.exponential(Duration.millis(policy.baseDelayMs)).pipe(
    Schedule.upTo({ times: policy.maxRetries }),
    Schedule.setInputType<RpcAttemptFailure>(),
    Schedule.modifyDelay(({ duration, input }) =>
      Effect.succeed(Duration.max(duration, Duration.millis(input.retryAfterMs))),
    ),
  )
}

function attemptProgram<A>(
  operation: string,
  task: RpcReadTask<A>,
  policy: RpcPolicy,
  deadline: RpcDeadline,
): Effect.Effect<A, RpcAttemptFailure> {
  const attempts = { count: 0 }
  const causeKey = Symbol(operation)
  const attempt = Effect.tryPromise({
    try: (signal) => {
      attempts.count += 1
      deadline.attempts += 1
      return task(signal)
    },
    catch: (cause) => {
      deadline.pendingCauses.delete(causeKey)
      deadline.pendingCauses.set(causeKey, cause)
      const classification = classifyRpcError(cause)
      return new RpcAttemptFailure({
        error: SugarRpcError.from({
          ...classification,
          attempts: attempts.count,
          cause: publicRpcCause(cause),
          operation,
        }),
        retryAfterMs: getRetryAfterMs(cause),
      })
    },
  })
  const retried = policy.maxRetries === 0
    ? attempt
    : Effect.retry(attempt, {
        schedule: retrySchedule(policy),
        while: (failure) => failure.error.retryable,
      })
  return Effect.tap(retried, () => Effect.sync(() => deadline.pendingCauses.delete(causeKey)))
}

function toReadResult<A>(
  program: Effect.Effect<A, RpcAttemptFailure>,
): Effect.Effect<RpcReadResult<A>, RpcAttemptFailure> {
  return program.pipe(
    Effect.map((value): RpcReadResult<A> => ({ ok: true, value })),
    Effect.catch((failure) =>
      failure.error.retryable
        ? Effect.fail(failure)
        : Effect.succeed<RpcReadResult<A>>({ error: failure.error, ok: false }),
    ),
  )
}

function makeDeadline(operation: string, policy: RpcPolicy): RpcDeadline {
  return {
    attempts: 0,
    deadlineMs: policy.deadlineMs,
    expiresAt: Date.now() + policy.deadlineMs,
    operation,
    pendingCauses: new Map(),
  }
}

function deadlineFailure(deadline: RpcDeadline): RpcDeadlineFailure {
  const pendingCauses = [...deadline.pendingCauses.values()]
  return new RpcDeadlineFailure({
    attempts: deadline.attempts,
    cause: pendingCauses.at(-1),
    deadlineMs: deadline.deadlineMs,
    operation: deadline.operation,
  })
}

function withDeadline<A, E>(
  effect: Effect.Effect<A, E>,
  deadline: RpcDeadline,
): Effect.Effect<A, E | RpcDeadlineFailure> {
  const remainingMs = deadline.expiresAt - Date.now()
  if (remainingMs <= 0) return Effect.fail(deadlineFailure(deadline))
  return Effect.timeoutOrElse(effect, {
    duration: Duration.millis(remainingMs),
    orElse: () => Effect.fail(deadlineFailure(deadline)),
  })
}

function toDeadlineError(failure: RpcDeadlineFailure): SugarRpcError {
  return SugarRpcError.from({
    attempts: failure.attempts,
    cause: failure.cause === undefined
      ? undefined
      : publicRpcCause(failure.cause),
    code: 'RPC_TIMEOUT',
    message: `RPC read ${failure.operation} exceeded its ${failure.deadlineMs}ms deadline`,
    operation: failure.operation,
    retryable: true,
  })
}

/** Surface only the domain error: internal attempt/deadline wrappers stay private. */
function toSugarRpcError<A>(
  program: Effect.Effect<A, RpcAttemptFailure | RpcDeadlineFailure>,
): Effect.Effect<A, SugarRpcError> {
  return program.pipe(
    Effect.catchTag('RpcAttemptFailure', (failure) => Effect.fail(failure.error)),
    Effect.catchTag('RpcDeadlineFailure', (failure) => Effect.fail(toDeadlineError(failure))),
  )
}

function withReadEvents<A, E>(
  effect: Effect.Effect<A, E>,
  observer: SugarRpcObserver | undefined,
  deadline: RpcDeadline,
  phase: 'batch' | 'read',
  itemCount: number,
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    const startedAt = Date.now()
    const event = (status: 'error' | 'success'): SugarRpcEvent => ({
      attemptCount: deadline.attempts,
      durationMs: Date.now() - startedAt,
      itemCount,
      operation: deadline.operation,
      phase,
      status,
    })
    return effect.pipe(
      Effect.tap(() => Effect.sync(() => emitRpcEvent(observer, event('success')))),
      Effect.tapCause(() => Effect.sync(() => emitRpcEvent(observer, event('error')))),
    )
  })
}

export type RpcReadExecutor = Readonly<{
  policy: RpcPolicy
  deadline(operation: string): RpcDeadline
  read<A>(operation: string, task: RpcReadTask<A>, deadline?: RpcDeadline): Effect.Effect<A, SugarRpcError>
  forEachRead<I, A>(
    operation: string,
    items: Iterable<I>,
    task: (item: I, index: number, signal: AbortSignal) => PromiseLike<A>,
    concurrency: number,
    deadline?: RpcDeadline,
  ): Effect.Effect<A[], SugarRpcError>
  forEachReadResult<I, A>(
    operation: string,
    items: Iterable<I>,
    task: (item: I, index: number, signal: AbortSignal) => PromiseLike<A>,
    concurrency: number,
    deadline?: RpcDeadline,
  ): Effect.Effect<Array<RpcReadResult<A>>, SugarRpcError>
}>

export function makeRpcReadExecutor(
  options: SugarRpcPolicyOptions = {},
  observer?: SugarRpcObserver,
): RpcReadExecutor {
  const policy = resolveRpcPolicy(options)

  const forEachProgram = <I, A, B>(
    operation: string,
    items: Iterable<I>,
    task: (item: I, index: number, signal: AbortSignal) => PromiseLike<A>,
    concurrency: number,
    requestedDeadline: RpcDeadline | undefined,
    toResult: (program: Effect.Effect<A, RpcAttemptFailure>) => Effect.Effect<B, RpcAttemptFailure>,
  ): Effect.Effect<B[], SugarRpcError> =>
    Effect.suspend(() => {
      const limit = positiveInteger(concurrency, 'requestConcurrency')
      const deadline = requestedDeadline ?? makeDeadline(operation, policy)
      const inputs = [...items]
      const program = Effect.forEach(
        inputs,
        (item, index) => toResult(attemptProgram(
          operation,
          (signal) => task(item, index, signal),
          policy,
          deadline,
        )),
        { concurrency: limit },
      )
      return toSugarRpcError(withDeadline(program, deadline)).pipe(
        (effect) => withReadEvents(effect, observer, deadline, 'batch', inputs.length),
      )
    })

  return {
    policy,
    deadline: (operation) => makeDeadline(operation, policy),
    read: (operation, task, requestedDeadline) =>
      Effect.suspend(() => {
        const deadline = requestedDeadline ?? makeDeadline(operation, policy)
        const program = attemptProgram(operation, task, policy, deadline)
        return toSugarRpcError(withDeadline(program, deadline)).pipe(
          (effect) => withReadEvents(effect, observer, deadline, 'read', 1),
        )
      }),
    forEachRead: (operation, items, task, concurrency, requestedDeadline) =>
      forEachProgram(operation, items, task, concurrency, requestedDeadline, (program) => program),
    forEachReadResult: (operation, items, task, concurrency, requestedDeadline) =>
      forEachProgram(operation, items, task, concurrency, requestedDeadline, toReadResult),
  }
}
