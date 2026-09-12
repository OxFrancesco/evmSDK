import { Clock, Context, Effect, Layer, Schedule } from 'effect'
import { BaseError, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, stringToHex, TransactionReceiptNotFoundError } from 'viem'
import type { Hex, LocalAccount } from 'viem'
import { EvmError } from './model'
import type { ExecuteInput, Operation, Plan, PrepareInput } from './model'
import { Network, rpc } from './network'
import { Store } from './storage'
import { reservePolicy } from './policy'
import { estimateFees } from './fees'
import { WalletRejected } from './browser-wallet'
import type { ExternalSigner } from './wallets'
import { executeSmart, reconcileSmart, resumeSmart } from './smart-execution'

export class Signer extends Context.Service<Signer, { readonly account: LocalAccount | null; readonly policy?: string; readonly external?: () => Effect.Effect<ExternalSigner | null, EvmError> }>()('@beegreat/evm/Signer') {}
export const signerLayer = (account: LocalAccount | null) => Layer.succeed(Signer, { account })

const intentFingerprint = (input: PrepareInput) => keccak256(stringToHex(JSON.stringify({
  chainId: input.chainId, account: input.account.toLowerCase(), to: input.to.toLowerCase(),
  data: input.data.toLowerCase(), value: input.value, policy: input.policy, deadline: input.deadline,
})))

const verifySigned = Effect.fn('Execution.verifySigned')((plan: Plan, raw: Hex, nonce: number) => Effect.tryPromise({
  try: async () => {
    const signed = parseTransaction(raw)
    if (signed.type !== (plan.feeType ?? 'legacy') || signed.r === undefined || signed.s === undefined || signed.v === undefined) throw new Error('Expected a signed transaction of the prepared type')
    const serialized = serializeTransaction(signed, { r: signed.r, s: signed.s, v: signed.v })
    if (serialized.toLowerCase() !== raw.toLowerCase()) throw new Error('Noncanonical signed transaction')
    const sender = await recoverTransactionAddress({ serializedTransaction: serialized })
    if (sender.toLowerCase() !== plan.account.toLowerCase() || signed.chainId !== plan.chainId || signed.to?.toLowerCase() !== plan.to.toLowerCase() || (signed.data ?? '0x').toLowerCase() !== plan.data.toLowerCase() || (signed.value ?? 0n) !== BigInt(plan.value) || signed.gas !== BigInt(plan.gas) || (signed.type === 'eip1559' ? signed.maxFeePerGas !== BigInt(plan.gasPrice) || signed.maxPriorityFeePerGas !== BigInt(plan.maxPriorityFeePerGas ?? '0') : signed.gasPrice !== BigInt(plan.gasPrice)) || signed.nonce !== nonce) throw new Error('Signed transaction does not match plan')
  }, catch: () => new EvmError({ code: 'InvalidState', message: 'The signed transaction does not match the approved plan.', retryable: false }),
}))

const simulate = Effect.fn('Execution.simulate')(function* (input: PrepareInput) {
  const network = yield* Network
  const connection = yield* network.client(input.chainId)
  const block = yield* rpc(() => connection.getBlockNumber())
  const request = { account: input.account, to: input.to, data: input.data, value: BigInt(input.value) }
  yield* Effect.tryPromise({
    try: () => connection.call({ ...request, blockNumber: block }),
    catch: error => new EvmError({
      code: error instanceof BaseError && error.shortMessage.toLowerCase().includes('revert') ? 'SimulationReverted' : 'RpcError',
      message: error instanceof BaseError ? error.shortMessage.replace(/https?:\/\/\S+/g, '[RPC endpoint]') : 'Simulation failed.',
      retryable: false,
    }),
  })
  const gas = yield* rpc(() => connection.estimateGas(request))
  const limit = gas * 120n / 100n
  const fees = yield* estimateFees(input, limit)
  return { block: block.toString(), gas: limit.toString(), ...fees }
})

export const prepare = Effect.fn('Execution.prepare')(function* (input: PrepareInput) {
  const signing = yield* Signer
  if (signing.policy && input.policy && input.policy !== signing.policy) return yield* new EvmError({ code: 'PolicyDenied', message: 'The configured signer policy cannot be overridden.', retryable: false })
  input = { ...input, policy: signing.policy ?? input.policy }
  const store = yield* Store
  const id = keccak256(stringToHex(input.key))
  const intentHash = intentFingerprint(input)
  const existing = yield* store.get(id).pipe(Effect.catchIf(error => error.code === 'NotFound', () => Effect.succeed(null)))
  if (existing) {
    if (existing.plan.intentHash !== intentHash) return yield* new EvmError({ code: 'IdempotencyConflict', message: 'This idempotency key belongs to a different action.', retryable: false })
    return existing
  }
  const simulation = yield* simulate(input)
  const now = yield* Clock.currentTimeMillis
  const expiresAt = Math.min(now + 600_000, input.deadline ?? Infinity)
  if (expiresAt <= now) return yield* new EvmError({ code: 'PlanExpired', message: 'Action deadline has expired.', retryable: false })
  const fingerprint = keccak256(stringToHex(JSON.stringify({ intentHash, ...simulation, expiresAt })))
  return yield* store.insert({
    plan: { ...input, id, intentHash, fingerprint, createdAt: now, expiresAt, simulationBlock: simulation.block, gas: simulation.gas, gasPrice: simulation.gasPrice, feeType: simulation.feeType, maxPriorityFeePerGas: simulation.maxPriorityFeePerGas, l1FeeEstimate: simulation.l1FeeEstimate },
    state: { _tag: 'prepared' },
  })
})

export const status: (id: string) => Effect.Effect<Operation, EvmError, Store | Network | Signer> = Effect.fn('Execution.status')(function* (id: string) {
  const store = yield* Store
  const operation = yield* store.get(id)
  const state = operation.state
  if (operation.remote) {
    const signer = yield* Signer
    const external = signer.external ? yield* signer.external() : null
    if (!external?.smart || external.address.toLowerCase() !== operation.plan.account.toLowerCase()) return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Reconnect the same Crossmint wallet to reconcile this operation.', retryable: false })
    return yield* reconcileSmart(operation, external.smart)
  }
  if (!('hash' in state) || !state.hash) return operation
  const connection = yield* (yield* Network).client(operation.plan.chainId)
  const hash = state.hash
  const receipt = yield* Effect.tryPromise({
    try: async () => { try { return await connection.getTransactionReceipt({ hash }) } catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error } },
    catch: () => new EvmError({ code: 'RpcError', message: 'Receipt reconciliation failed. Preserve the existing submission.', retryable: true }),
  })
  if (state._tag === 'walletPending' && state.hash) {
    const tx = yield* rpc(() => connection.getTransaction({ hash }))
    const plan = operation.plan
    if (tx.from.toLowerCase() !== plan.account.toLowerCase() || tx.to?.toLowerCase() !== plan.to.toLowerCase() || tx.input.toLowerCase() !== plan.data.toLowerCase() || tx.value !== BigInt(plan.value) || state.nonce >= 0 && tx.nonce !== state.nonce || tx.gas > BigInt(plan.gas) || (tx.maxFeePerGas ?? tx.gasPrice) > BigInt(plan.gasPrice)) return yield* new EvmError({ code: 'InvalidState', message: 'The wallet submitted a transaction that differs from the approved plan. Inspect wallet activity.', retryable: false })
  }
  const signed = operation.signed ?? (state._tag === 'pending' || state._tag === 'submitting' ? { raw: state.raw, hash: state.hash, nonce: state.nonce } : undefined)
  if (!receipt) {
    if (operation.plan.replacement) {
      const original = yield* status(operation.plan.replacement.id)
      if (original.state._tag === 'confirmed' || original.state._tag === 'reverted') {
        const superseded: Operation = { ...operation, state: { _tag: 'superseded', by: original.plan.id } }
        yield* store.save(superseded); return superseded
      }
    }
    if (state._tag === 'confirmed' || state._tag === 'reverted') {
      const restored: Operation = { ...operation, state: signed ? { _tag: 'submitting', ...signed } : { _tag: 'walletPending', hash: state.hash, nonce: -1 } }
      yield* store.save(restored); return restored
    }
    return operation
  }
  const block = yield* rpc(() => connection.getBlock({ blockNumber: receipt.blockNumber }))
  if (block.hash !== receipt.blockHash) {
    const restored: Operation = { ...operation, state: signed ? { _tag: 'submitting', ...signed } : { _tag: 'walletPending', hash, nonce: 'nonce' in state ? state.nonce : -1 } }
    yield* store.save(restored); return restored
  }
  const finalized = yield* rpc(() => connection.getBlock({ blockTag: 'finalized' })).pipe(Effect.result)
  const safe = yield* rpc(() => connection.getBlock({ blockTag: 'safe' })).pipe(Effect.result)
  const finality = finalized._tag === 'Success' && finalized.success.number >= receipt.blockNumber ? 'finalized' : safe._tag === 'Success' && safe.success.number >= receipt.blockNumber ? 'safe' : 'included'
  const updated: Operation = { ...operation, signed, state: { _tag: receipt.status === 'success' ? 'confirmed' : 'reverted', hash: receipt.transactionHash, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), finality } }
  yield* store.save(updated)
  if (operation.plan.replacement) {
    const original = yield* store.get(operation.plan.replacement.id)
    yield* store.save({ ...original, state: { _tag: 'superseded', by: id } })
  }
  return updated
})

const sign = Effect.fn('Execution.sign')(function* (operation: Operation) {
  const signer = yield* Signer
  const account = signer.account
  const external = !account && signer.external ? yield* signer.external() : null
  if (!account && !external) return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Connect a wallet or configure an unattended SDK signer.', retryable: false })
  const plan = operation.plan
  if (signer.policy && plan.policy !== signer.policy) return yield* new EvmError({ code: 'PolicyDenied', message: 'Prepare a fresh plan under the configured signer policy.', retryable: false })
  if ((account?.address ?? external?.address)?.toLowerCase() !== plan.account.toLowerCase()) return yield* new EvmError({ code: 'AccountMismatch', message: 'The configured signer does not match the plan account.', retryable: false })
  const now = yield* Clock.currentTimeMillis
  if (now > plan.expiresAt) return yield* new EvmError({ code: 'PlanExpired', message: 'Prepare a fresh plan using a new idempotency key.', retryable: false })
  if (plan.replacement) {
    const original = yield* status(plan.replacement.id)
    if (original.state._tag !== 'pending' && original.state._tag !== 'submitting') return yield* new EvmError({ code: 'InvalidState', message: 'Original transaction is no longer pending. Reconcile before replacing it.', retryable: false })
  }
  const preflight = external?.preflight
  if (preflight) yield* Effect.tryPromise({ try: () => preflight(plan.chainId), catch: error => error instanceof EvmError ? error : new EvmError({ code: 'SignerInteractionRequired', message: 'Reconnect the selected wallet in an interactive terminal.', retryable: false }) })
  const refreshed = yield* simulate(plan)
  if (BigInt(refreshed.l1FeeEstimate) > BigInt(plan.l1FeeEstimate ?? '0')) return yield* new EvmError({ code: 'InvalidState', message: 'L1 data fee estimate increased. Prepare a fresh plan.', retryable: false })
  if (BigInt(refreshed.gas) > BigInt(plan.gas)) return yield* new EvmError({ code: 'InvalidState', message: 'Gas requirements increased beyond the prepared limit. Prepare a fresh plan.', retryable: false })
  const network = yield* Network
  const connection = yield* network.client(plan.chainId)
  const nonce = plan.replacement?.nonce ?? (yield* rpc(() => connection.getTransactionCount({ address: plan.account, blockTag: 'pending' })))
  if ((yield* Clock.currentTimeMillis) > plan.expiresAt) return yield* new EvmError({ code: 'PlanExpired', message: 'The plan expired during simulation. Prepare a fresh plan.', retryable: false })
  yield* reservePolicy(plan)
  const store = yield* Store
  if (external) {
    if (external.smart) return yield* executeSmart(operation, external.smart)
    const pending: Operation = { plan, state: { _tag: 'walletPending', hash: null, nonce } }
    yield* store.save(pending)
    const result = yield* Effect.tryPromise({ try: () => external.send(plan, nonce), catch: error => error }).pipe(Effect.result)
    if (result._tag === 'Failure') {
      if (result.failure instanceof WalletRejected) { yield* store.save(operation); return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Wallet rejected the request before submission.', retryable: false }) }
      return yield* new EvmError({ code: 'SubmissionUncertain', message: 'Wallet response is unresolved. Use attach-transaction with the wallet transaction hash. Never repeat this submission blindly.', retryable: false })
    }
    const sent: Operation = { plan, state: { _tag: 'walletPending', hash: result.success, nonce } }
    yield* store.save(sent)
    return sent
  }
  if (!account) return yield* new EvmError({ code: 'SignerInteractionRequired', message: 'Signer unavailable.', retryable: false })
  const raw = yield* Effect.tryPromise({
    try: () => account.signTransaction({ chainId: plan.chainId, nonce, to: plan.to, data: plan.data, value: BigInt(plan.value), gas: BigInt(plan.gas), ...(plan.feeType === 'eip1559' ? { type: 'eip1559', maxFeePerGas: BigInt(plan.gasPrice), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas ?? '0') } as const : { type: 'legacy', gasPrice: BigInt(plan.gasPrice) } as const) }),
    catch: () => new EvmError({ code: 'SignerInteractionRequired', message: 'The signer did not produce a signed transaction.', retryable: false }),
  })
  yield* verifySigned(plan, raw, nonce)
  const signed: Operation = { plan, state: { _tag: 'submitting', hash: keccak256(raw), raw, nonce } }
  yield* store.save({ ...signed, signed: { raw, hash: keccak256(raw), nonce } })
  return signed
})

export const execute = Effect.fn('Execution.execute')(function* (input: ExecuteInput) {
  const store = yield* Store
  const initial = yield* status(input.id)
  if (initial.state._tag === 'confirmed' || initial.state._tag === 'reverted' || initial.state._tag === 'superseded') return initial
  if (initial.state._tag === 'cancelled') return yield* new EvmError({ code: 'InvalidState', message: 'This plan was cancelled. Prepare a new plan.', retryable: false })
  if (input.approval._tag === 'required' || (input.approval._tag === 'approved' && input.approval.fingerprint !== initial.plan.fingerprint)) return yield* new EvmError({ code: 'ApprovalRequired', message: `Review operation ${input.id}, then pass --approve ${initial.plan.fingerprint} or --yolo.`, retryable: false })
  return yield* Effect.acquireUseRelease(store.lock(initial), () => Effect.gen(function* () {
    let operation = yield* status(input.id)
    if (operation.state._tag === 'prepared') operation = yield* sign(operation)
    if (operation.state._tag === 'walletPending') {
      if (operation.remote) {
        const signer = yield* Signer
        const external = signer.external ? yield* signer.external() : null
        if (external?.smart) return yield* resumeSmart(operation, external.smart)
      }
      return yield* status(input.id)
    }
    const state = operation.state
    if (state._tag !== 'submitting' && state._tag !== 'pending') return operation
    yield* verifySigned(operation.plan, state.raw, state.nonce)
    if (keccak256(state.raw) !== state.hash) return yield* new EvmError({ code: 'InvalidState', message: 'Persisted transaction hash does not match its signed bytes.', retryable: false })
    const network = yield* Network
    const connection = yield* network.client(operation.plan.chainId)
    const receipt = yield* rpc(() => connection.getTransactionReceipt({ hash: state.hash })).pipe(Effect.catchIf(() => true, () => Effect.succeed(null)))
    if (receipt) return yield* status(input.id)
    const submitted = yield* rpc(() => connection.sendRawTransaction({ serializedTransaction: state.raw })).pipe(Effect.result)
    if (submitted._tag === 'Success') {
      if (submitted.success !== state.hash) return yield* new EvmError({ code: 'SubmissionUncertain', message: `RPC returned an unexpected hash. Inspect operation ${input.id}.`, retryable: false })
      operation = { plan: operation.plan, signed: { raw: state.raw, hash: state.hash, nonce: state.nonce }, state: { ...state, _tag: 'pending' } }
      yield* store.save(operation)
    }
    const reconciled = yield* status(input.id)
    if (reconciled.state._tag === 'confirmed' || reconciled.state._tag === 'reverted') return reconciled
    if (submitted._tag === 'Failure') return yield* new EvmError({ code: 'SubmissionUncertain', message: `Submission outcome is unresolved. Run status for ${input.id}. Execute the same operation to rebroadcast identical signed bytes.`, retryable: false })
    return reconciled
  }), () => store.unlock(initial).pipe(Effect.orDie))
})

export const waitForOperation = Effect.fn('Execution.wait')(function* (id: string) {
  return yield* status(id).pipe(Effect.repeat({ while: operation => operation.state._tag === 'pending' || operation.state._tag === 'submitting' || operation.state._tag === 'walletPending', schedule: Schedule.spaced('1 second').pipe(Schedule.upTo({ times: 29 })) }))
})

export const cancel = Effect.fn('Execution.cancel')(function* (id: string) {
  const store = yield* Store
  const operation = yield* store.get(id)
  return yield* Effect.acquireUseRelease(store.lock(operation), () => Effect.gen(function* () {
    const fresh = yield* store.get(id)
    if (fresh.state._tag !== 'prepared') return yield* new EvmError({ code: 'InvalidState', message: 'Only an unsigned prepared plan can be cancelled.', retryable: false })
    const cancelled: Operation = { plan: fresh.plan, state: { _tag: 'cancelled' } }
    yield* store.save(cancelled)
    return cancelled
  }), () => store.unlock(operation).pipe(Effect.orDie))
})

export const attachTransaction = Effect.fn('Execution.attach')(function* (input: { readonly id: string; readonly hash: `0x${string}` }) {
  const store = yield* Store
  const operation = yield* store.get(input.id)
  if (operation.state._tag !== 'walletPending') return yield* new EvmError({ code: 'InvalidState', message: 'Only an unresolved wallet submission can attach a transaction hash.', retryable: false })
  const client = yield* (yield* Network).client(operation.plan.chainId)
  const transaction = yield* rpc(() => client.getTransaction({ hash: input.hash }))
  const plan = operation.plan
  if (transaction.from.toLowerCase() !== plan.account.toLowerCase() || transaction.to?.toLowerCase() !== plan.to.toLowerCase() || transaction.input.toLowerCase() !== plan.data.toLowerCase() || transaction.value !== BigInt(plan.value) || transaction.nonce !== operation.state.nonce || transaction.gas > BigInt(plan.gas) || (transaction.maxFeePerGas ?? transaction.gasPrice) > BigInt(plan.gasPrice)) return yield* new EvmError({ code: 'InvalidInput', message: 'Wallet transaction does not match the reviewed plan and nonce.', retryable: false })
  yield* store.save({ ...operation, state: { ...operation.state, hash: input.hash } })
  return yield* status(input.id)
})

export interface ReplaceInput { readonly id: string; readonly key: string; readonly gasPrice: string; readonly maxPriorityFeePerGas?: string; readonly cancel: boolean }
export const prepareReplacement = Effect.fn('Execution.prepareReplacement')(function* (input: ReplaceInput) {
  const original = yield* status(input.id)
  if (original.state._tag !== 'pending' && original.state._tag !== 'submitting') return yield* new EvmError({ code: 'InvalidState', message: 'Replacement requires an unresolved transaction signed by this toolkit.', retryable: false })
  const minFee = (BigInt(original.plan.gasPrice) * 113n + 99n) / 100n
  if (BigInt(input.gasPrice) < minFee || original.plan.feeType === 'eip1559' && BigInt(input.maxPriorityFeePerGas ?? '0') < (BigInt(original.plan.maxPriorityFeePerGas ?? '0') * 113n + 99n) / 100n) return yield* new EvmError({ code: 'InvalidInput', message: 'Replacement must raise both fee caps by at least 13 percent.', retryable: false })
  const originalPlan = original.plan
  const prepared = yield* prepare({ chainId: originalPlan.chainId, account: originalPlan.account, to: input.cancel ? originalPlan.account : originalPlan.to, data: input.cancel ? '0x' : originalPlan.data, value: input.cancel ? '0' : originalPlan.value, key: input.key, policy: originalPlan.policy, deadline: originalPlan.deadline })
  if (prepared.plan.replacement) {
    if (prepared.plan.replacement.id !== input.id || prepared.plan.gasPrice !== input.gasPrice || prepared.plan.maxPriorityFeePerGas !== input.maxPriorityFeePerGas) return yield* new EvmError({ code: 'IdempotencyConflict', message: 'Replacement key belongs to another fee or transaction.', retryable: false })
    return prepared
  }
  if (prepared.state._tag !== 'prepared') return prepared
  const replacement = { id: input.id, nonce: original.state.nonce }
  const plan = { ...prepared.plan, gasPrice: input.gasPrice, maxPriorityFeePerGas: input.maxPriorityFeePerGas, replacement, fingerprint: keccak256(stringToHex(JSON.stringify({ fingerprint: prepared.plan.fingerprint, gasPrice: input.gasPrice, maxPriorityFeePerGas: input.maxPriorityFeePerGas, replacement }))) }
  const operation: Operation = { plan, state: { _tag: 'prepared' } }
  yield* (yield* Store).save(operation)
  return operation
})
