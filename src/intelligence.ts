import { Effect, Schema } from 'effect'
import { Abi as AbiValidator } from 'abitype/zod'
import { decodeErrorResult, decodeEventLog, decodeFunctionData, keccak256, stringify } from 'viem'
import { normalize } from 'viem/ens'
import { simulateCalls } from 'viem/actions'
import { Address, ChainId, ContractInput, EvmError, Hex, Uint } from './model'
import { resolveContract } from './contracts'
import { Network, rpc } from './network'
import { Signer } from './execution'
import { Socket } from './socket'

export const SimulationInput = Schema.Struct({ chainId: ChainId, account: Address, calls: Schema.Array(Schema.Struct({ to: Address, data: Hex, value: Uint })).check(Schema.isMinLength(1), Schema.isMaxLength(32)) })
export const simulation = Effect.fn('Simulation.assetChanges')(function* (input: Schema.Schema.Type<typeof SimulationInput>) {
  const client = yield* (yield* Network).client(input.chainId)
  const block = yield* rpc(() => client.getBlockNumber())
  const result = yield* rpc(() => simulateCalls(client, { account: input.account, calls: input.calls.map(call => ({ ...call, value: BigInt(call.value) })), blockNumber: block, traceAssetChanges: true, validation: true })).pipe(Effect.result)
  if (result._tag === 'Failure') return { available: false, succeeded: null, chainId: input.chainId, block: block.toString(), reason: result.failure.message, result: null }
  return { available: true, succeeded: result.success.results.every(call => call.status === 'success'), chainId: input.chainId, block: block.toString(), reason: null, result: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(result.success)) }
})
export const DecodeInput = Schema.Struct({ ...ContractInput.fields, data: Hex, topics: Schema.optionalKey(Schema.Array(Hex)), kind: Schema.Literals(['call', 'error', 'event']) })
export const decode = Effect.fn('Contracts.decode')(function* (input: Schema.Schema.Type<typeof DecodeInput>) {
  const resolved = yield* resolveContract(input)
  const abi = AbiValidator.parse(resolved.abi)
  const [topic, ...rest] = input.topics ?? []
  const topics: [] | [`0x${string}`, ...`0x${string}`[]] = topic ? [topic, ...rest] : []
  return yield* Effect.try({ try: () => {
    const result = input.kind === 'call' ? decodeFunctionData({ abi, data: input.data }) : input.kind === 'error' ? decodeErrorResult({ abi, data: input.data }) : decodeEventLog({ abi, data: input.data, topics })
    return { chainId: input.chainId, address: input.address, source: resolved.source, result: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(result)) }
  }, catch: () => new EvmError({ code: 'InvalidInput', message: 'ABI cannot decode this calldata, error or event.', retryable: false }) })
})
export const resolveName = Effect.fn('Names.resolve')(function* (input: { readonly name: string; readonly chainId: number }) {
  const client = yield* (yield* Network).client(input.chainId)
  const address = yield* rpc(() => client.getEnsAddress({ name: normalize(input.name) }))
  if (!address) return yield* new EvmError({ code: 'NotFound', message: 'Name did not resolve on this chain.', retryable: false })
  return { ...input, address }
})
export const capabilities = Effect.fn('Capabilities.inspect')(function* (chainId: number) {
  const client = yield* (yield* Network).client(chainId)
  const signer = yield* Signer
  const external = signer.external ? yield* signer.external() : null
  const block = yield* rpc(() => client.getBlock())
  const safe = yield* rpc(() => client.getBlock({ blockTag: 'safe' })).pipe(Effect.result)
  const finalized = yield* rpc(() => client.getBlock({ blockTag: 'finalized' })).pipe(Effect.result)
  const simulated = yield* rpc(() => simulateCalls(client, { calls: [{ to: '0x0000000000000000000000000000000000000000', value: 0n }], traceAssetChanges: true })).pipe(Effect.result)
  return { chainId, block: block.number.toString(), eip1559: block.baseFeePerGas !== null, safeBlocks: safe._tag === 'Success', finalizedBlocks: finalized._tag === 'Success', assetSimulation: simulated._tag === 'Success', signer: signer.account ? { address: signer.account.address, interactive: false } : external ? { address: external.address, interactive: external.interactive } : null, socketEndpoint: (yield* Socket).endpoint }
})
export const codeIdentity = Effect.fn('Contracts.identity')(function* (input: Schema.Schema.Type<typeof ContractInput>) {
  const resolved = yield* resolveContract(input)
  const client = yield* (yield* Network).client(input.chainId)
  const code = yield* rpc(() => client.getCode({ address: resolved.implementation ?? input.address, blockNumber: BigInt(resolved.block) }))
  return { ...resolved, codeHash: code ? keccak256(code) : null, descriptionsTrusted: false }
})
