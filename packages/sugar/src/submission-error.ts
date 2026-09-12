import * as Predicate from 'effect/Predicate'

export class TransactionNotSubmittedError extends Error {
  override readonly name = 'TransactionNotSubmittedError'
}

export function isExplicitWalletRejection(cause: unknown): boolean {
  if (!Predicate.isObject(cause) || !('code' in cause)) return false
  return cause.code === 4001 || cause.code === 5000
}
