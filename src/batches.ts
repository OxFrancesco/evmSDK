import { Clock, Effect, Schema } from 'effect'
import { keccak256, numberToHex, stringToHex } from 'viem'
import { Address, ChainId, EvmError, ExecuteInput, Hash, Hex, Id, Uint } from './model'
import { Signer } from './execution'
import { Store } from './storage'
import { simulation } from './intelligence'
import { Network, rpc } from './network'

export const BatchInput = Schema.Struct({ key: Id, chainId: ChainId, account: Address, calls: Schema.Array(Schema.Struct({ to: Address, data: Hex, value: Uint })).check(Schema.isMinLength(1), Schema.isMaxLength(32)), atomicRequired: Schema.Boolean, paymasterUrl: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https:\/\//))) })
export const Batch = Schema.Struct({ ...BatchInput.fields, id: Hash, fingerprint: Hash, expiresAt: Schema.Number, state: Schema.Literals(['prepared', 'submitting', 'pending', 'confirmed', 'failed', 'partial']), walletStatus: Schema.NullOr(Schema.Json) })
const Response = Schema.Struct({ id: Schema.String, chainId: Hex, status: Schema.Number, atomic: Schema.Boolean, receipts: Schema.optionalKey(Schema.Array(Schema.Struct({ transactionHash: Hash }))) })
export const prepareBatch = Effect.fn('Batch.prepare')(function* (input: Schema.Schema.Type<typeof BatchInput>) {
  const id = keccak256(stringToHex(`batch:${input.key}`))
  const fingerprint = keccak256(stringToHex(JSON.stringify(input)))
  const expiresAt = (yield* Clock.currentTimeMillis) + 600000
  const record = yield* (yield* Store).updateDocument(`batch:${id}`, existing => {
    if (existing) { const previous = Schema.decodeUnknownSync(Batch)(existing); if (previous.fingerprint !== fingerprint) throw new EvmError({ code: 'IdempotencyConflict', message: 'Batch key belongs to other calls.', retryable: false }); return previous }
    return { ...input, id, fingerprint, expiresAt, state: 'prepared', walletStatus: null }
  })
  return Schema.decodeUnknownSync(Batch)(record)
})
const getBatch = Effect.fn('Batch.get')(function* (id: string) {
  return yield* Schema.decodeUnknownEffect(Batch)(yield* (yield* Store).document(`batch:${id}`)).pipe(Effect.mapError(() => new EvmError({ code: 'NotFound', message: 'Batch does not exist.', retryable: false })))
})
export const batchStatus = Effect.fn('Batch.status')(function* (id: string) {
  const batch = yield* getBatch(id)
  if (batch.state === 'prepared') return batch
  const signer = yield* Signer
  const external = signer.external ? yield* signer.external() : null
  if (!external?.request || external.address.toLowerCase() !== batch.account.toLowerCase()) return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Reconnect the batch wallet to query its status.', retryable: false })
  const request = external.request
  const response = yield* Effect.tryPromise({ try: () => request('wallet_getCallsStatus', [id], batch.chainId), catch: () => new EvmError({ code: 'SubmissionUncertain', message: 'Wallet batch status is unavailable. Its persisted ID remains recoverable; do not submit a new batch.', retryable: false }) })
  const status = yield* Schema.decodeUnknownEffect(Response)(response).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidState', message: 'Wallet returned an invalid batch status.', retryable: false })))
  if (status.id !== id || BigInt(status.chainId) !== BigInt(batch.chainId) || batch.atomicRequired && status.status === 200 && !status.atomic) return yield* new EvmError({ code: 'InvalidState', message: 'Wallet batch result violates the requested identity, chain or atomicity.', retryable: false })
  const state = status.status >= 600 ? 'partial' : status.status >= 400 ? 'failed' : status.status >= 200 && status.status < 300 ? 'confirmed' : 'pending'
  if (state === 'confirmed') {
    if (!status.receipts?.length) return yield* new EvmError({ code: 'InvalidState', message: 'Wallet reports completion without transaction receipts.', retryable: false })
    const client = yield* (yield* Network).client(batch.chainId)
    for (const claimed of status.receipts) {
      const receipt = yield* rpc(() => client.getTransactionReceipt({ hash: claimed.transactionHash }))
      const block = yield* rpc(() => client.getBlock({ blockNumber: receipt.blockNumber }))
      if (receipt.status !== 'success' || receipt.blockHash !== block.hash) return yield* new EvmError({ code: 'OutcomeMismatch', message: 'Wallet batch receipt is reverted or no longer canonical.', retryable: false })
    }
  }
  const next = { ...batch, state, walletStatus: response }
  yield* (yield* Store).putDocument(`batch:${id}`, next)
  return Schema.decodeUnknownSync(Batch)(next)
})
export const runBatch = Effect.fn('Batch.run')(function* (input: Schema.Schema.Type<typeof ExecuteInput>) {
  const batch = yield* getBatch(input.id)
  if (batch.state !== 'prepared') return yield* batchStatus(input.id)
  if (input.approval._tag === 'required' || input.approval._tag === 'approved' && input.approval.fingerprint !== batch.fingerprint) return yield* new EvmError({ code: 'ApprovalRequired', message: `Review and approve batch ${batch.fingerprint} or use --yolo.`, retryable: false })
  if ((yield* Clock.currentTimeMillis) >= batch.expiresAt) return yield* new EvmError({ code: 'PlanExpired', message: 'Prepare a fresh batch with a new key.', retryable: false })
  const signer = yield* Signer
  if (signer.policy) return yield* new EvmError({ code: 'CapabilityUnavailable', message: 'This policy requires per-transaction fee and spending enforcement. Use workflow-run or an on-chain policy signer for batching.', retryable: false })
  const external = signer.external ? yield* signer.external() : null
  if (!external?.request || external.address.toLowerCase() !== batch.account.toLowerCase()) return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Connect a wallet supporting EIP-5792 batches.', retryable: false })
  const preflight = external.preflight
  if (preflight) yield* Effect.tryPromise({ try: () => preflight(batch.chainId), catch: () => new EvmError({ code: 'SignerInteractionRequired', message: 'Reconnect the batch wallet in an interactive terminal.', retryable: false }) })
  const simulated = yield* simulation(batch)
  if (!simulated.available) return yield* new EvmError({ code: 'CapabilityUnavailable', message: 'Use an RPC supporting eth_simulateV1 to preflight wallet batches.', retryable: false })
  if (!simulated.succeeded) return yield* new EvmError({ code: 'SimulationReverted', message: 'One or more batch calls reverted during simulation.', retryable: false })
  const request = external.request
  const store = yield* Store
  yield* store.updateDocument(`batch:${batch.id}`, existing => {
    const latest = Schema.decodeUnknownSync(Batch)(existing)
    if (latest.state !== 'prepared') throw new EvmError({ code: 'AccountBusy', message: 'This batch was already submitted. Reconcile it by ID.', retryable: false })
    return { ...latest, state: 'submitting' }
  })
  const response = yield* Effect.tryPromise({ try: () => request('wallet_sendCalls', [{ version: '2.0.0', id: batch.id, from: batch.account, chainId: numberToHex(batch.chainId), atomicRequired: batch.atomicRequired, calls: batch.calls.map(call => ({ ...call, value: numberToHex(BigInt(call.value)) })), capabilities: batch.paymasterUrl ? { paymasterService: { url: batch.paymasterUrl } } : {} }], batch.chainId), catch: () => new EvmError({ code: 'SubmissionUncertain', message: 'Batch response is unresolved. Query batch-status with this same ID; never resubmit a new batch.', retryable: false }) })
  const sent = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(response)
  if (sent._tag === 'None' || sent.value.id !== batch.id) return yield* new EvmError({ code: 'SubmissionUncertain', message: 'Wallet did not preserve the requested batch ID. Inspect wallet activity.', retryable: false })
  return yield* batchStatus(batch.id)
})
