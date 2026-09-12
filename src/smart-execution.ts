import { Effect } from 'effect'
import { decodeEventLog, parseAbi, TransactionReceiptNotFoundError } from 'viem'
import { entryPoint06Address, entryPoint07Address, entryPoint08Address } from 'viem/account-abstraction'
import { EvmError } from './model'
import type { Operation, Plan } from './model'
import type { SmartWalletAdapter, SmartTransaction } from './crossmint'
import { Store } from './storage'
import { Network, rpc } from './network'

const entryPoints = [entryPoint06Address, entryPoint07Address, entryPoint08Address].map(address => address.toLowerCase())
const event = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)'])
export function matchesSmartPlan(plan: Plan, tx: SmartTransaction) {
  return plan.chainId === tx.chainId && plan.account.toLowerCase() === tx.account.toLowerCase() && plan.to.toLowerCase() === tx.to.toLowerCase() && plan.data.toLowerCase() === tx.data.toLowerCase() && plan.value === tx.value
}
const providerCall = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new EvmError({ code: 'SubmissionUncertain', message: 'Crossmint operation remains unresolved. Reconnect the same wallet and query this operation. Do not create a new transfer.', retryable: false }) })
export const reconcileSmart = Effect.fn('SmartWallet.reconcile')(function* (operation: Operation, adapter: SmartWalletAdapter) {
  const remote = operation.remote
  if (!remote) return operation
  const tx = yield* providerCall(() => adapter.status(remote.id))
  if (tx.id !== remote.id || !matchesSmartPlan(operation.plan, tx) || tx.userOperationHash !== remote.userOperationHash) return yield* new EvmError({ code: 'InvalidState', message: 'Crossmint transaction differs from the recorded operation.', retryable: false })
  if (tx.status === 'failed') return yield* new EvmError({ code: 'OutcomeMismatch', message: 'Crossmint reports that this operation failed. Inspect its existing provider ID before preparing a new action.', retryable: false })
  const restore = Effect.gen(function* () {
    const pending: Operation = { ...operation, state: { _tag: 'walletPending', hash: tx.hash, nonce: -1 } }
    yield* (yield* Store).save(pending)
    return pending
  })
  const hash = tx.hash
  if (!hash || tx.status !== 'success') return yield* restore
  const client = yield* (yield* Network).client(operation.plan.chainId)
  const receipt = yield* Effect.tryPromise({ try: () => client.getTransactionReceipt({ hash }), catch: error => error }).pipe(Effect.catch(error => error instanceof TransactionReceiptNotFoundError ? Effect.succeed(null) : Effect.fail(new EvmError({ code: 'RpcError', message: 'Cannot verify the smart-wallet receipt.', retryable: true }))))
  if (!receipt) return yield* restore
  const block = yield* rpc(() => client.getBlock({ blockNumber: receipt.blockNumber }))
  if (block.hash !== receipt.blockHash) return yield* restore
  const matching = receipt.logs.flatMap(log => {
    if (!entryPoints.includes(log.address.toLowerCase())) return []
    try { const decoded = decodeEventLog({ abi: event, data: log.data, topics: log.topics }); return decoded.args.userOpHash === remote.userOperationHash && decoded.args.sender.toLowerCase() === operation.plan.account.toLowerCase() ? [decoded.args] : [] } catch { return [] }
  })
  const execution = matching[0]
  if (!execution) return yield* new EvmError({ code: 'OutcomeMismatch', message: 'Receipt does not contain the expected smart-wallet UserOperation event.', retryable: false })
  const updated: Operation = { ...operation, state: { _tag: receipt.status === 'success' && execution.success ? 'confirmed' : 'reverted', hash: tx.hash, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: execution.actualGasUsed.toString(), finality: 'included' } }
  yield* (yield* Store).save(updated)
  return updated
})
export const executeSmart = Effect.fn('SmartWallet.execute')(function* (operation: Operation, adapter: SmartWalletAdapter) {
  if (operation.plan.policy) return yield* new EvmError({ code: 'CapabilityUnavailable', message: 'Local EOA fee policies cannot bound Crossmint sponsorship or account-abstraction fees. Use a Crossmint signer with on-chain scopes.', retryable: false })
  const tx = yield* providerCall(() => adapter.prepare(operation.plan))
  if (!matchesSmartPlan(operation.plan, tx) || tx.status !== 'awaiting-approval') return yield* new EvmError({ code: 'InvalidState', message: 'Crossmint did not return the requested unsigned transaction.', retryable: false })
  const recorded: Operation = { ...operation, remote: { provider: 'crossmint', id: tx.id, userOperationHash: tx.userOperationHash }, state: { _tag: 'walletPending', hash: null, nonce: -1 } }
  yield* (yield* Store).save(recorded)
  yield* providerCall(() => adapter.approve(tx.id, operation.plan))
  return yield* reconcileSmart(recorded, adapter)
})

export const resumeSmart = Effect.fn('SmartWallet.resume')(function* (operation: Operation, adapter: SmartWalletAdapter) {
  const remote = operation.remote
  if (!remote) return operation
  const tx = yield* providerCall(() => adapter.status(remote.id))
  if (tx.id !== remote.id || tx.userOperationHash !== remote.userOperationHash || !matchesSmartPlan(operation.plan, tx)) return yield* new EvmError({ code: 'InvalidState', message: 'Crossmint transaction differs from the recorded operation.', retryable: false })
  if (tx.status === 'awaiting-approval') {
    if (operation.plan.expiresAt <= Date.now()) return yield* new EvmError({ code: 'PlanExpired', message: 'This Crossmint approval expired. Inspect its existing provider transaction before preparing another action.', retryable: false })
    yield* providerCall(() => adapter.approve(remote.id, operation.plan))
  }
  return yield* reconcileSmart(operation, adapter)
})
