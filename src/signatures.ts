import { Effect, Schema } from 'effect'
import { verifyHash } from 'viem/actions'
import { hashTypedData, stringify } from 'viem'
import { Address, ChainId, EvmError, ExecuteInput, Hash, Id } from './model'
import { Signer } from './execution'
import { Network, rpc } from './network'
import { Store } from './storage'

export const TypedInput = Schema.Struct({ chainId: ChainId, account: Address, key: Id, domain: Schema.Struct({ name: Schema.optionalKey(Schema.String), version: Schema.optionalKey(Schema.String), chainId: ChainId, verifyingContract: Address, salt: Schema.optionalKey(Hash) }), types: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))), primaryType: Schema.String, message: Schema.Record(Schema.String, Schema.Json), approval: Schema.optionalKey(ExecuteInput.fields.approval) })
export const typedSignature = Effect.fn('Signatures.typedData')(function* (input: Schema.Schema.Type<typeof TypedInput>) {
  if (input.chainId !== input.domain.chainId) return yield* new EvmError({ code: 'ChainMismatch', message: 'Typed-data domain chain differs from the requested chain.', retryable: false })
  const payload = { domain: input.domain, types: input.types, primaryType: input.primaryType, message: input.message }
  const fingerprint = yield* Effect.try({ try: () => hashTypedData(payload), catch: () => new EvmError({ code: 'InvalidInput', message: 'Invalid EIP-712 typed data.', retryable: false }) })
  const approval = input.approval
  if (!approval || approval._tag === 'required' || approval._tag === 'approved' && approval.fingerprint !== fingerprint) return { fingerprint, signature: null, account: input.account, chainId: input.chainId }
  const store = yield* Store
  const existing = yield* store.document(`signature:${input.key}`)
  const Record = Schema.Struct({ fingerprint: Hash, signature: Schema.TemplateLiteral(['0x', Schema.String]), account: Address, chainId: ChainId })
  if (existing) {
    const record = Schema.decodeUnknownSync(Record)(existing)
    if (record.fingerprint !== fingerprint || record.account.toLowerCase() !== input.account.toLowerCase()) return yield* new EvmError({ code: 'IdempotencyConflict', message: 'Signature key belongs to different typed data.', retryable: false })
    return record
  }
  const signer = yield* Signer
  if (signer.policy) return yield* new EvmError({ code: 'PolicyDenied', message: 'Typed-data signatures can grant off-chain spending authority. This transaction policy does not authorize them.', retryable: false })
  const external = !signer.account && signer.external ? yield* signer.external() : null
  if ((signer.account?.address ?? external?.address)?.toLowerCase() !== input.account.toLowerCase()) return yield* new EvmError({ code: 'AccountMismatch', message: 'Typed-data signer does not match the selected account.', retryable: false })
  const signature = yield* Effect.tryPromise({ try: async () => {
    if (signer.account) return await signer.account.signTypedData(payload)
    if (external?.request) return Schema.decodeUnknownSync(Record.fields.signature)(await external.request('eth_signTypedData_v4', [input.account, stringify(payload)], input.chainId))
    throw new Error('Typed-data signing is unavailable.')
  }, catch: () => new EvmError({ code: 'SignerInteractionRequired', message: 'The selected wallet did not sign the typed data.', retryable: false }) })
  const client = yield* (yield* Network).client(input.chainId)
  const valid = yield* rpc(() => verifyHash(client, { hash: fingerprint, address: input.account, signature }))
  if (!valid) return yield* new EvmError({ code: 'InvalidState', message: 'Wallet signature does not verify against the requested account and typed data.', retryable: false })
  const record = { fingerprint, signature, account: input.account, chainId: input.chainId }
  yield* store.putDocument(`signature:${input.key}`, record)
  return record
})
export const WalletCapabilityInput = Schema.Struct({ chainId: ChainId })
export const walletCapabilities = Effect.fn('Wallet.capabilities')(function* (chainId: number) {
  const signer = yield* Signer
  const external = signer.external ? yield* signer.external() : null
  if (!external?.request) return { available: false, capabilities: null }
  const request = external.request
  const capabilities = yield* Effect.tryPromise({ try: () => request('wallet_getCapabilities', [external.address, [`0x${chainId.toString(16)}`]], chainId), catch: () => new EvmError({ code: 'CapabilityUnavailable', message: 'Wallet does not expose EIP-5792 capabilities.', retryable: false }) })
  return { available: true, capabilities }
})
