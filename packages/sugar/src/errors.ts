import * as Schema from 'effect/Schema'

export const SUGAR_RPC_ERROR_CODES = [
  'RPC_RATE_LIMITED',
  'RPC_READ_FAILED',
  'RPC_TIMEOUT',
  'RPC_UNAVAILABLE',
] as const

export type SugarRpcErrorCode = (typeof SUGAR_RPC_ERROR_CODES)[number]

function defaultMessage(code: SugarRpcErrorCode, operation: string): string {
  if (code === 'RPC_TIMEOUT') return `RPC read ${operation} timed out`
  if (code === 'RPC_RATE_LIMITED') return `RPC read ${operation} was rate limited`
  if (code === 'RPC_UNAVAILABLE') return `RPC read ${operation} is unavailable`
  return `RPC read ${operation} failed`
}

/**
 * Typed failure for every Sugar RPC read. `retryable` mirrors the transient
 * classification (throttling, outages, timeouts) used by the retry schedule;
 * deterministic contract reverts are never retried.
 */
export class SugarRpcError extends Schema.TaggedError<SugarRpcError>()('SugarRpcError', {
  code: Schema.Literals(SUGAR_RPC_ERROR_CODES),
  operation: Schema.String,
  retryable: Schema.Boolean,
  attempts: Schema.Int,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  /** Construct with the standard per-code message when none is supplied. */
  static from(options: {
    code: SugarRpcErrorCode
    operation: string
    retryable: boolean
    attempts: number
    cause?: unknown
    message?: string
  }): SugarRpcError {
    const fields = {
      attempts: options.attempts,
      code: options.code,
      message: options.message ?? defaultMessage(options.code, options.operation),
      operation: options.operation,
      retryable: options.retryable,
    }
    return options.cause === undefined
      ? new SugarRpcError(fields)
      : new SugarRpcError({ ...fields, cause: options.cause })
  }
}
