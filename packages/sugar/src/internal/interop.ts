import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { SugarRpcError } from '../errors'

/**
 * Run a Sugar effect at the promise edge of the SDK. Typed failures and
 * defects are rethrown with their original identity so promise consumers
 * (backend, CLI, tests) keep observing the exact SugarRpcError / Error
 * instances they always did.
 */
export async function runSugar<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/**
 * Bridge a promise-returning SugarClient method back into an effect. Client
 * methods stay promise-shaped on purpose (subclass overrides and test stubs
 * dispatch through them), so composite flows re-enter Effect here. A typed
 * SugarRpcError stays in the error channel; anything else is a defect,
 * exactly as a thrown precondition error behaves inside Effect.gen.
 */
export function clientCall<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, SugarRpcError> {
  return Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => cause instanceof SugarRpcError ? Effect.fail(cause) : Effect.die(cause)),
  )
}
