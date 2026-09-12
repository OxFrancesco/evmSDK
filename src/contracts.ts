import { Abi as AbiValidator } from 'abitype/zod'
import { Effect, Redacted, Schema } from 'effect'
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, stringify } from 'viem'
import type { Abi } from 'viem'
import { CallInput, ContractInput, EvmError } from './model'
import { Network, rpc } from './network'

const abiSchema = Schema.declare<Abi>((input): input is Abi => AbiValidator.safeParse(input).success)
const explorerResponse = Schema.Struct({ status: Schema.String, message: Schema.String, result: Schema.String })
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export const resolveContract = Effect.fn('Contracts.resolve')(function* (input: Schema.Schema.Type<typeof ContractInput>) {
  const network = yield* Network
  const connection = yield* network.client(input.chainId)
  const block = input.block === undefined ? yield* rpc(() => connection.getBlockNumber()) : BigInt(input.block)
  const code = yield* rpc(() => connection.getCode({ address: input.address, blockNumber: block }))
  if (!code || code === '0x') return yield* new EvmError({ code: 'AbiUnavailable', message: 'No contract bytecode exists at this address on the selected chain.', retryable: false })
  if (input.abi) {
    const abi = yield* Schema.decodeUnknownEffect(abiSchema)(input.abi).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'The supplied ABI is invalid.', retryable: false })))
    return { address: input.address, implementation: null, abi, source: 'provided' as const, block: block.toString() }
  }
  if (input.signatures) {
    const abi = yield* Effect.try({ try: () => parseAbi(input.signatures ?? []), catch: () => new EvmError({ code: 'InvalidInput', message: 'Invalid human-readable ABI signatures.', retryable: false }) })
    return { address: input.address, implementation: null, abi, source: 'signatures' as const, block: block.toString() }
  }
  const stored = yield* rpc(() => connection.getStorageAt({ address: input.address, slot: implementationSlot, blockNumber: block }))
  const implementation = stored && BigInt(stored) !== 0n ? getAddress(`0x${stored.slice(-40)}`) : null
  const apiKey = network.options.etherscanApiKey
  if (!apiKey) return yield* new EvmError({ code: 'AbiUnavailable', message: 'Supply abi or signatures, or configure EVM_ETHERSCAN_API_KEY for verified ABI discovery. Automatic proxy resolution supports the EIP-1967 implementation slot.', retryable: false })
  const url = new URL('https://api.etherscan.io/v2/api')
  url.search = new URLSearchParams({ chainid: String(input.chainId), module: 'contract', action: 'getabi', address: implementation ?? input.address, apikey: Redacted.value(apiKey) }).toString()
  const body = yield* Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      if (!response.ok) throw new Error('Explorer HTTP failure')
      return response.json()
    }, catch: () => new EvmError({ code: 'AbiUnavailable', message: 'ABI explorer request failed. Supply an ABI or retry discovery.', retryable: true }),
  })
  const response = yield* Schema.decodeUnknownEffect(explorerResponse)(body).pipe(Effect.mapError(() => new EvmError({ code: 'AbiUnavailable', message: 'Invalid ABI explorer response.', retryable: false })))
  if (response.status !== '1') return yield* new EvmError({ code: 'AbiUnavailable', message: 'Explorer has no available verified ABI. Check API access or supply signatures.', retryable: false })
  const abi = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(abiSchema))(response.result).pipe(Effect.mapError(() => new EvmError({ code: 'AbiUnavailable', message: 'Explorer returned an invalid ABI.', retryable: false })))
  return { address: input.address, implementation, abi, source: 'etherscan' as const, block: block.toString() }
})

export const encodeCall = Effect.fn('Contracts.encode')(function* (input: CallInput) {
  const contract = yield* resolveContract(input)
  const data = yield* Effect.try({
    try: () => encodeFunctionData({ abi: contract.abi, functionName: input.functionName, args: [...input.args ?? []] }),
    catch: () => new EvmError({ code: 'InvalidInput', message: 'Function or arguments do not match the ABI. Use decimal strings for large integers and JSON booleans, arrays, or tuples.', retryable: false }),
  })
  return { ...contract, data }
})

export const readContract = Effect.fn('Contracts.read')(function* (input: CallInput) {
  const contract = yield* encodeCall(input)
  const network = yield* Network
  const connection = yield* network.client(input.chainId)
  const block = input.block ? BigInt(input.block) : BigInt(contract.block)
  const result = yield* rpc(() => connection.call({ to: input.address, data: contract.data, account: input.account, blockNumber: block }))
  const value = yield* Effect.try({
    try: () => decodeFunctionResult({ abi: contract.abi, functionName: input.functionName, data: result.data ?? '0x' }),
    catch: () => new EvmError({ code: 'InvalidInput', message: 'Return data could not be decoded with this ABI.', retryable: false }),
  })
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(stringify(value) ?? 'null').pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'Contract result cannot be serialized.', retryable: false })))
  return { chainId: input.chainId, address: input.address, block: block.toString(), value: json }
})
