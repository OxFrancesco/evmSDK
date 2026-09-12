import { Effect, Schema, Stream, Schedule } from 'effect'
import { keccak256, stringToHex, stringify } from 'viem'
import { CallInput, Address, ChainId, EvmError, Hash, Id, Uint } from './model'
import { Network, rpc } from './network'
import { readContract } from './contracts'
import { Store } from './storage'

export const MonitorInput = Schema.Struct({ name: Id, chainId: ChainId, address: Address, fromBlock: Uint, confirmations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })) })
const Event = Schema.Struct({ address: Address, data: Schema.String, topics: Schema.Array(Hash), block: Uint, blockHash: Hash, transactionHash: Hash, logIndex: Schema.Number })
export const Monitor = Schema.Struct({ ...MonitorInput.fields, cursor: Uint, checkpoint: Schema.NullOr(Schema.Struct({ block: Uint, hash: Hash })), paused: Schema.Boolean })
const Batch = Schema.Struct({ id: Hash, name: Id, fromBlock: Uint, toBlock: Uint, blockHash: Hash, reorg: Schema.Boolean, events: Schema.Array(Event) })
export const createMonitor = Effect.fn('Monitor.create')(function* (input: Schema.Schema.Type<typeof MonitorInput>) {
  const monitor = { ...input, cursor: input.fromBlock, checkpoint: null, paused: false }
  yield* (yield* Store).updateDocument(`monitor:${input.name}`, value => {
    if (value !== null) throw new EvmError({ code: 'InvalidState', message: 'Monitor already exists. Resume it or use another name.', retryable: false })
    return monitor
  })
  return monitor
})
const getMonitor = Effect.fn('Monitor.get')(function* (name: string) {
  return yield* Schema.decodeUnknownEffect(Monitor)(yield* (yield* Store).document(`monitor:${name}`)).pipe(Effect.mapError(() => new EvmError({ code: 'NotFound', message: 'Monitor does not exist.', retryable: false })))
})
export const pollMonitor = Effect.fn('Monitor.poll')(function* (name: string) {
  const monitor = yield* getMonitor(name)
  const store = yield* Store
  const pending = yield* store.document(`monitor-batch:${name}`)
  if (pending) return Schema.decodeUnknownSync(Batch)(pending)
  if (monitor.paused) return null
  const client = yield* (yield* Network).client(monitor.chainId)
  const head = yield* rpc(() => client.getBlockNumber())
  const tip = head - BigInt(monitor.confirmations)
  let cursor = BigInt(monitor.cursor)
  let reorg = false
  if (monitor.checkpoint) {
    const savedCheckpoint = monitor.checkpoint
    const checkpoint = yield* rpc(() => client.getBlock({ blockNumber: BigInt(savedCheckpoint.block) }))
    if (checkpoint.hash !== monitor.checkpoint.hash) { reorg = true; cursor = cursor > 256n ? cursor - 256n : 0n }
  }
  if (cursor > tip || tip < 0n) return null
  const to = cursor + 999n < tip ? cursor + 999n : tip
  const block = yield* rpc(() => client.getBlock({ blockNumber: to }))
  const logs = yield* rpc(() => client.getLogs({ address: monitor.address, fromBlock: cursor, toBlock: to }))
  const events = logs.flatMap(log => log.blockNumber !== null && log.blockHash !== null && log.transactionHash !== null && log.logIndex !== null ? [{ address: log.address, data: log.data, topics: log.topics, block: log.blockNumber.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex }] : [])
  const batch = { id: keccak256(stringToHex(`${name}:${cursor}:${block.hash}`)), name, fromBlock: cursor.toString(), toBlock: to.toString(), blockHash: block.hash, reorg, events }
  const saved = yield* store.updateDocument(`monitor-batch:${name}`, current => current ?? batch)
  return Schema.decodeUnknownSync(Batch)(saved)
})
export const acknowledgeMonitor = Effect.fn('Monitor.acknowledge')(function* (name: string, id: string) {
  const store = yield* Store
  const batch = Schema.decodeUnknownSync(Batch)(yield* store.document(`monitor-batch:${name}`))
  if (batch.id !== id) return yield* new EvmError({ code: 'InvalidInput', message: 'Acknowledgement does not match the pending event batch.', retryable: false })
  const monitor = yield* getMonitor(name)
  const next = { ...monitor, cursor: (BigInt(batch.toBlock) + 1n).toString(), checkpoint: { block: batch.toBlock, hash: batch.blockHash } }
  yield* store.commitDocuments([{ key: `monitor:${name}`, expected: monitor, value: next }, { key: `monitor-batch:${name}`, expected: batch, value: null }])
  return next
})
export const pauseMonitor = Effect.fn('Monitor.pause')(function* (name: string, paused: boolean) {
  const monitor = yield* getMonitor(name)
  const next = { ...monitor, paused }
  yield* (yield* Store).putDocument(`monitor:${name}`, next)
  return next
})

export const readWatchInput = Schema.Struct({ name: Id, call: CallInput, count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 60000 })) })
export const readWatchSample = Schema.Struct({ name: Id, chainId: ChainId, address: Address, block: Uint, value: Schema.Json, changed: Schema.Boolean })
export const readWatch = (input: Schema.Schema.Type<typeof readWatchInput>) => Stream.fromEffect(Effect.gen(function* () {
  const store = yield* Store
  const last = yield* store.document(`read-watch:${input.name}`)
  const observed = yield* readContract(input.call)
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(observed.value))
  const prior = Schema.decodeUnknownOption(Schema.Struct({ call: CallInput, value: Schema.Json }))(last)
  if (prior._tag === 'Some' && JSON.stringify(prior.value.call) !== JSON.stringify(input.call)) return yield* new EvmError({ code: 'IdempotencyConflict', message: 'Watch name belongs to a different contract read.', retryable: false })
  const changed = prior._tag === 'None' || JSON.stringify(prior.value.value) !== JSON.stringify(value)
  yield* store.putDocument(`read-watch:${input.name}`, { call: input.call, value })
  return { ...observed, value, name: input.name, changed }
})).pipe(Stream.repeat(Schedule.spaced(input.intervalMs)), Stream.take(input.count))
