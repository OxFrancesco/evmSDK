import { Safe4337Pack, SafeOperationV07 } from '@safe-global/relay-kit'
import { EthSafeSignature } from '@safe-global/protocol-kit'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import { decodeEventLog, encodeFunctionData, parseAbi, stringify, zeroAddress } from 'viem'
import { entryPoint07Address, entryPoint07Abi, getUserOperationHash, toPackedUserOperation } from 'viem/account-abstraction'
import { Address, ChainId, Hash, Hex, Id } from '../model'
import { Signer } from '../execution'
import { Network, rpc } from '../network'
import { Store } from '../storage'
import { decodeSafe, safeAbi, safeError, validateOwners } from './contracts'
import { extension } from './module-contracts'
import { SafeBatchInput, SafeCall, SafeCreateInput, SafeTarget, SafeUint } from './model'
import { safeInfo } from './wallet'
import { safeBatchPropose, validateSafeCall } from './batch'

export interface SafeRelayOptions { readonly safeRelay?: { readonly chainId: number; readonly bundlerUrl: Redacted.Redacted<string>; readonly paymasterUrl: Redacted.Redacted<string>; readonly sponsorshipPolicyId?: string } }
export class SafeRelay extends Context.Service<SafeRelay, SafeRelayOptions>()('@beegreat/evm/SafeRelay') {}
export const safeRelayLayer = (options: SafeRelayOptions) => Layer.succeed(SafeRelay, SafeRelay.of(options))
const Signature = Schema.Struct({ owner: Address, data: Hex, contract: Schema.Boolean })
const UserOperation = Schema.Struct({ sender: Address, nonce: Schema.String, factory: Schema.optionalKey(Address), factoryData: Schema.optionalKey(Hex), callData: Hex, callGasLimit: SafeUint, verificationGasLimit: SafeUint, preVerificationGas: SafeUint, maxFeePerGas: SafeUint, maxPriorityFeePerGas: SafeUint, paymaster: Address, paymasterData: Hex, paymasterVerificationGasLimit: SafeUint, paymasterPostOpGasLimit: SafeUint, signature: Hex })
export const SafeSponsoredInput = Schema.Struct({ chainId: ChainId, wallet: Schema.Union([Schema.Struct({ safe: Address }), Schema.Struct({ owners: SafeCreateInput.fields.owners, threshold: SafeCreateInput.fields.threshold, saltNonce: SafeUint })]), calls: SafeBatchInput.fields.calls, key: Id })
export const SafeSponsoredRecord = Schema.Struct({ id: Id, fingerprint: Hash, input: SafeSponsoredInput, safe: Address, userOperation: UserOperation, validUntil: Schema.Number, signatures: Schema.Array(Signature), state: Schema.Literals(['prepared', 'pending', 'confirmed', 'reverted', 'cancelled']), userOperationHash: Schema.NullOr(Hash), transactionHash: Schema.NullOr(Hash) })
export interface SafeSponsoredRecord extends Schema.Schema.Type<typeof SafeSponsoredRecord> {}
export const SafeSponsoredId = Schema.Struct({ id: Id })
export const SafeSponsoredSignInput = Schema.Struct({ id: Id, fingerprint: Hash })
export const SafeSponsoredSignatureInput = Schema.Struct({ ...SafeSponsoredSignInput.fields, signature: Signature })
export const SafeSponsoredSubmitInput = SafeSponsoredSignInput
const relayCall = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => safeError('Safe relay request failed. Inspect the stored operation before retrying. Endpoint credentials are redacted.') })
const recordKey = (id: string) => `safe-relay:${id}`
const readRecord = Effect.fn('SafeRelay.read')(function* (id: string) {
  const record = yield* (yield* Store).document(recordKey(id))
  if (!record) return yield* safeError('Sponsored operation not found.')
  return yield* decodeSafe(SafeSponsoredRecord, record)
})
const saveRecord = Effect.fn('SafeRelay.save')(function* (previous: SafeSponsoredRecord | null, record: SafeSponsoredRecord) {
  yield* (yield* Store).commitDocuments([{ key: recordKey(record.id), expected: previous, value: record }])
  return record
})
const packFor = Effect.fn('SafeRelay.connect')(function* (input: typeof SafeSponsoredInput.Type) {
  const config = (yield* SafeRelay).safeRelay
  if (!config || config.chainId !== input.chainId) return yield* safeError('Configure a bundler and paymaster for this exact chain before sponsored execution.')
  const connection = yield* (yield* Network).client(input.chainId)
  const module = yield* extension(input.chainId, 'erc4337')
  if ('safe' in input.wallet) {
    const info = yield* safeInfo({ chainId: input.chainId, safe: input.wallet.safe })
    if (!info.modules.some(address => address.toLowerCase() === module.toLowerCase())) return yield* safeError('Enable the Safe 4337 module and fallback handler first.')
  }
  const pack = yield* relayCall(() => Safe4337Pack.init({ provider: { request: request => connection.transport.request(request) }, bundlerUrl: Redacted.value(config.bundlerUrl), safeModulesVersion: '0.3.0', customContracts: { entryPointAddress: entryPoint07Address, safe4337ModuleAddress: module }, options: 'safe' in input.wallet ? { safeAddress: input.wallet.safe } : { ...input.wallet, owners: [...input.wallet.owners], safeVersion: '1.4.1' }, paymasterOptions: { isSponsored: true, paymasterUrl: Redacted.value(config.paymasterUrl), sponsorshipPolicyId: config.sponsorshipPolicyId } }))
  if (BigInt(yield* relayCall(() => pack.getChainId())) !== BigInt(input.chainId)) return yield* safeError('Bundler chain does not match the requested chain.')
  return pack
})
const restore = (record: SafeSponsoredRecord) => {
  const op = record.userOperation
  const operation = new SafeOperationV07({ ...op, callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit), preVerificationGas: BigInt(op.preVerificationGas), maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas), paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit), paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit) }, { chainId: BigInt(record.input.chainId), moduleAddress: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226', entryPoint: entryPoint07Address, validUntil: record.validUntil })
  for (const signature of record.signatures) operation.addSignature(new EthSafeSignature(signature.owner, signature.data, signature.contract))
  return operation
}
const editable = Effect.fn('SafeRelay.editable')(function* (input: typeof SafeSponsoredSignInput.Type) {
  const record = yield* readRecord(input.id)
  if (record.fingerprint !== input.fingerprint || record.state !== 'prepared' || record.validUntil * 1000 <= Date.now()) return yield* safeError('Sponsored operation changed, expired, or is no longer editable.')
  if (restore(record).getHash().toLowerCase() !== record.fingerprint.toLowerCase()) return yield* safeError('Stored sponsored operation hash differs from its reviewed contents.')
  return record
})
export const safeSponsoredEnable = Effect.fn('SafeRelay.enable')(function* (raw: typeof SafeTarget.Type) {
  const input = yield* decodeSafe(SafeTarget, raw)
  const info = yield* safeInfo(input)
  const module = yield* extension(input.chainId, 'erc4337')
  const calls: typeof SafeCall.Type[] = [{ to: input.safe, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'setFallbackHandler', args: [module] }) }]
  if (!info.modules.some(address => address.toLowerCase() === module.toLowerCase())) calls.unshift({ to: input.safe, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }) })
  return yield* safeBatchPropose({ ...input, calls })
})
export const safeSponsoredPropose = Effect.fn('SafeRelay.propose')(function* (raw: typeof SafeSponsoredInput.Type) {
  const input = yield* decodeSafe(SafeSponsoredInput, raw)
  const existing = yield* (yield* Store).document(recordKey(input.key))
  if (existing) {
    const record = yield* decodeSafe(SafeSponsoredRecord, existing)
    if (JSON.stringify(record.input) !== JSON.stringify(input)) return yield* safeError('Idempotency key already belongs to another sponsored operation.')
    return record
  }
  if ('owners' in input.wallet) yield* validateOwners(input.wallet.owners, input.wallet.threshold)
  const pack = yield* packFor(input)
  const validUntil = Math.floor(Date.now() / 1000) + 600
  const operation = yield* relayCall(() => pack.createTransaction({ transactions: input.calls.map(call => ({ ...call, operation: 0 })), options: { validUntil } }))
  const serialized = yield* decodeSafe(Schema.fromJsonString(UserOperation), stringify(operation.userOperation))
  for (const call of input.calls) yield* validateSafeCall({ ...call, chainId: input.chainId, safe: serialized.sender, operation: 0 })
  if (serialized.paymaster === zeroAddress) return yield* safeError('The provider did not sponsor this operation.')
  const record: SafeSponsoredRecord = { id: input.key, fingerprint: yield* decodeSafe(Hash, operation.getHash()), input, safe: serialized.sender, userOperation: serialized, validUntil, signatures: [], state: 'prepared', userOperationHash: null, transactionHash: null }
  return yield* saveRecord(null, record)
})
export const safeSponsoredSignature = Effect.fn('SafeRelay.signature')(function* (raw: typeof SafeSponsoredSignatureInput.Type) {
  const input = yield* decodeSafe(SafeSponsoredSignatureInput, raw)
  const record = yield* editable(input)
  const owners = 'safe' in record.input.wallet ? (yield* safeInfo({ chainId: record.input.chainId, safe: record.safe })).owners : record.input.wallet.owners
  if (!owners.some(owner => owner.toLowerCase() === input.signature.owner.toLowerCase())) return yield* safeError('Signature is not from a current owner.')
  return yield* saveRecord(record, { ...record, signatures: [...record.signatures.filter(signature => signature.owner.toLowerCase() !== input.signature.owner.toLowerCase()), input.signature] })
})
export const safeSponsoredSign = Effect.fn('SafeRelay.sign')(function* (raw: typeof SafeSponsoredSignInput.Type) {
  const input = yield* decodeSafe(SafeSponsoredSignInput, raw)
  const record = yield* editable(input)
  const signer = (yield* Signer).account
  if (!signer?.signTypedData) return yield* safeError('Connect an EOA signer or attach a passkey/contract signature using safe-sponsored-signature.')
  const operation = restore(record)
  const data = yield* relayCall(() => signer.signTypedData({ domain: { chainId: record.input.chainId, verifyingContract: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226' }, types: operation.getEIP712Type(), primaryType: 'SafeOp', message: operation.getSafeOperation() }))
  return yield* safeSponsoredSignature({ ...input, signature: { owner: signer.address, data, contract: false } })
})
export const safeSponsoredSubmit = Effect.fn('SafeRelay.submit')(function* (raw: typeof SafeSponsoredSubmitInput.Type) {
  const input = yield* decodeSafe(SafeSponsoredSubmitInput, raw)
  let record = yield* readRecord(input.id)
  if (record.fingerprint !== input.fingerprint || record.state === 'cancelled') return yield* safeError('Exact sponsored-operation approval is required.')
  if (record.state === 'confirmed' || record.state === 'reverted') return record
  const pack = yield* packFor(record.input)
  const operation = restore(record)
  if (operation.getHash().toLowerCase() !== record.fingerprint.toLowerCase()) return yield* safeError('Stored sponsored operation was modified.')
  if (record.state === 'prepared') {
    yield* editable(input)
    const threshold = 'safe' in record.input.wallet ? (yield* safeInfo({ chainId: record.input.chainId, safe: record.safe })).threshold : record.input.wallet.threshold
    if (record.signatures.length < threshold) return yield* safeError('More owner signatures are required.')
    const op = operation.getUserOperation()
    const decoded = yield* decodeSafe(UserOperation, JSON.parse(stringify(op)))
    const userOperation = { ...decoded, nonce: BigInt(decoded.nonce), callGasLimit: BigInt(decoded.callGasLimit), verificationGasLimit: BigInt(decoded.verificationGasLimit), preVerificationGas: BigInt(decoded.preVerificationGas), maxFeePerGas: BigInt(decoded.maxFeePerGas), maxPriorityFeePerGas: BigInt(decoded.maxPriorityFeePerGas), paymasterVerificationGasLimit: BigInt(decoded.paymasterVerificationGasLimit), paymasterPostOpGasLimit: BigInt(decoded.paymasterPostOpGasLimit) }
    const connection = yield* (yield* Network).client(record.input.chainId)
    yield* rpc(() => connection.call({ to: entryPoint07Address, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[toPackedUserOperation(userOperation)], record.safe] }) }))
    const userOperationHash = getUserOperationHash({ chainId: record.input.chainId, entryPointAddress: entryPoint07Address, entryPointVersion: '0.7', userOperation })
    record = yield* saveRecord(record, { ...record, state: 'pending', userOperationHash })
  }
  const hash = yield* relayCall(() => pack.executeTransaction({ executable: operation }))
  if (hash.toLowerCase() !== record.userOperationHash?.toLowerCase()) return yield* safeError('Bundler returned a different operation hash. Inspect the recorded operation.')
  return record
})
export const safeSponsoredStatus = Effect.fn('SafeRelay.status')(function* (raw: typeof SafeSponsoredId.Type) {
  const input = yield* decodeSafe(SafeSponsoredId, raw)
  const record = yield* readRecord(input.id)
  if (!record.userOperationHash) return record
  const pack = yield* packFor(record.input)
  const remote = yield* relayCall(() => pack.getUserOperationReceipt(record.userOperationHash ?? ''))
  if (!remote) {
    if (record.state === 'confirmed' || record.state === 'reverted') return yield* saveRecord(record, { ...record, state: 'pending', transactionHash: null })
    return record
  }
  const hash = yield* decodeSafe(Hash, remote.receipt.transactionHash)
  const connection = yield* (yield* Network).client(record.input.chainId)
  const receipt = yield* rpc(() => connection.getTransactionReceipt({ hash }))
  const block = yield* rpc(() => connection.getBlock({ blockNumber: receipt.blockNumber }))
  if (block.hash !== receipt.blockHash) return yield* safeError('UserOperation receipt is no longer in the canonical chain. Check status again.')
  const event = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)'])
  const matches = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== entryPoint07Address.toLowerCase()) return []
    try { const decoded = decodeEventLog({ abi: event, data: log.data, topics: log.topics }); return decoded.args.userOpHash === record.userOperationHash && decoded.args.sender.toLowerCase() === record.safe.toLowerCase() ? [decoded.args] : [] } catch { return [] }
  })
  const result = matches[0]
  if (!result || result.paymaster.toLowerCase() !== record.userOperation.paymaster.toLowerCase() || result.nonce !== BigInt(record.userOperation.nonce)) return yield* safeError('Receipt has no matching sponsored Safe UserOperation event.')
  return yield* saveRecord(record, { ...record, transactionHash: hash, state: receipt.status === 'success' && result.success ? 'confirmed' : 'reverted' })
})
export const safeSponsoredCancel = Effect.fn('SafeRelay.cancel')(function* (raw: typeof SafeSponsoredId.Type) {
  const input = yield* decodeSafe(SafeSponsoredId, raw)
  const record = yield* readRecord(input.id)
  if (record.state !== 'prepared') return yield* safeError('Only an unsubmitted sponsored operation can be cancelled locally.')
  return yield* saveRecord(record, { ...record, state: 'cancelled' })
})
