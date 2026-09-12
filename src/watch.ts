import { Effect, Schedule, Schema, Stream } from 'effect'
import { ChainId } from './model'
import { Network, rpc } from './network'

export const WatchInput = Schema.Struct({
  chainId: ChainId,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 60_000 })),
})
export const BlockSample = Schema.Struct({ chainId: ChainId, number: Schema.String, hash: Schema.NullOr(Schema.String) })

export function watchBlocks(input: Schema.Schema.Type<typeof WatchInput>) {
  return Stream.unwrap(Effect.gen(function* () {
    const connection = yield* (yield* Network).client(input.chainId)
    const sample = rpc(() => connection.getBlock()).pipe(Effect.map(block => ({ chainId: input.chainId, number: block.number?.toString() ?? 'pending', hash: block.hash })))
    return Stream.fromEffectSchedule(sample, Schedule.spaced(input.intervalMs)).pipe(Stream.take(input.count))
  }))
}
