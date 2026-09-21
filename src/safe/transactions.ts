import { Effect } from 'effect'
import { concatHex, encodeFunctionData, hashTypedData, padHex, zeroAddress } from 'viem'
import { prepare } from '../execution'
import { publicOperation } from '../model'
import { Network, rpc } from '../network'
import { decodeSafe, safeAbi, safeError, sentinel, validateOwners } from './contracts'
import { SafeApprovalInput, SafeOwnerChangeInput, SafeProposalInput, SafeTarget, SafeTransaction, SafeTransactionInput } from './model'
import { safeInfo } from './wallet'
import { validateSafeCall } from './batch'

const safeTypes = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
] }
export const safeTransactionHash = (transaction: Omit<SafeTransaction, 'hash'>) => hashTypedData({
  domain: { chainId: transaction.chainId, verifyingContract: transaction.safe }, types: safeTypes, primaryType: 'SafeTx',
  message: { to: transaction.to, value: BigInt(transaction.value), data: transaction.data, operation: transaction.operation ?? 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: BigInt(transaction.nonce) },
})

export const safePropose = Effect.fn('Safe.propose')(function* (raw: typeof SafeProposalInput.Type) {
  const input = yield* decodeSafe(SafeProposalInput, raw)
  yield* validateSafeCall(input)
  if (input.to === zeroAddress) return yield* safeError('Safe transaction destination cannot be zero.')
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const transaction = { ...input, nonce: info.nonce }
  return { ...transaction, hash: safeTransactionHash(transaction) }
})

export const safeApprovals = Effect.fn('Safe.approvals')(function* (raw: typeof SafeTransactionInput.Type) {
  const input = yield* decodeSafe(SafeTransactionInput, raw)
  const tx = input.transaction
  if (input.chainId !== tx.chainId || safeTransactionHash(tx).toLowerCase() !== tx.hash.toLowerCase()) return yield* safeError('Safe transaction chain or hash does not match its contents.')
  yield* validateSafeCall(tx)
  const info = yield* safeInfo({ chainId: input.chainId, safe: tx.safe })
  if (info.nonce !== tx.nonce) return yield* safeError('Safe nonce changed. This transaction is stale; inspect the chain before proposing another.')
  const connection = yield* (yield* Network).client(input.chainId)
  const blockNumber = BigInt(info.block)
  const onChainHash = yield* rpc(() => connection.readContract({ address: tx.safe, abi: safeAbi, functionName: 'getTransactionHash', args: [tx.to, BigInt(tx.value), tx.data, tx.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, BigInt(tx.nonce)], blockNumber }))
  if (onChainHash.toLowerCase() !== tx.hash.toLowerCase()) return yield* safeError('Safe contract returned a different transaction hash.')
  const approvals = yield* Effect.forEach(info.owners, owner => rpc(() => connection.readContract({ address: tx.safe, abi: safeAbi, functionName: 'approvedHashes', args: [owner, tx.hash], blockNumber })), { concurrency: 4 })
  const approved = info.owners.filter((_, i) => approvals[i] !== undefined && approvals[i] !== 0n).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return { transaction: tx, owners: info.owners, approved, threshold: info.threshold, ready: approved.length >= info.threshold, block: info.block }
})

export const safeApprove = Effect.fn('Safe.approve')(function* (raw: typeof SafeApprovalInput.Type) {
  const input = yield* decodeSafe(SafeApprovalInput, raw)
  const status = yield* safeApprovals({ chainId: input.chainId, transaction: input.transaction })
  if (!status.owners.some(owner => owner.toLowerCase() === input.account.toLowerCase())) return yield* safeError('The approving account is not a Safe owner.')
  const data = encodeFunctionData({ abi: safeAbi, functionName: 'approveHash', args: [input.transaction.hash] })
  return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: input.transaction.safe, value: '0', data, key: input.key }))
})

export const safeExecute = Effect.fn('Safe.execute')(function* (raw: typeof SafeApprovalInput.Type) {
  const input = yield* decodeSafe(SafeApprovalInput, raw)
  const status = yield* safeApprovals({ chainId: input.chainId, transaction: input.transaction })
  if (!status.ready) return yield* safeError(`Safe requires ${status.threshold} on-chain approvals; found ${status.approved.length}.`)
  const signatures = concatHex(status.approved.slice(0, status.threshold).map(owner => concatHex([padHex(owner, { size: 32 }), padHex('0x', { size: 32 }), '0x01'])))
  const tx = input.transaction
  const data = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [tx.to, BigInt(tx.value), tx.data, tx.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] })
  return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: tx.safe, value: '0', data, key: input.key }))
})

export const safeCancelProposal = Effect.fn('Safe.cancelProposal')(function* (raw: typeof SafeTarget.Type) {
  const input = yield* decodeSafe(SafeTarget, raw)
  return yield* safePropose({ ...input, to: input.safe, value: '0', data: '0x' })
})

export const safeChangeOwner = Effect.fn('Safe.changeOwner')(function* (raw: typeof SafeOwnerChangeInput.Type) {
  const input = yield* decodeSafe(SafeOwnerChangeInput, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const change = input.change
  let data: `0x${string}`
  switch (change.kind) {
    case 'add':
      yield* validateOwners([...info.owners, change.owner], change.threshold, input.safe)
      data = encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [change.owner, BigInt(change.threshold)] })
      break
    case 'remove': {
      const index = info.owners.findIndex(owner => owner.toLowerCase() === change.owner.toLowerCase())
      if (index < 0) return yield* safeError('The address to remove is not a Safe owner.')
      yield* validateOwners(info.owners.filter((_, i) => i !== index), change.threshold, input.safe)
      const previous = index === 0 ? sentinel : info.owners[index - 1]
      if (!previous) return yield* safeError('Safe owner ordering changed.')
      data = encodeFunctionData({ abi: safeAbi, functionName: 'removeOwner', args: [previous, change.owner, BigInt(change.threshold)] })
      break
    }
    case 'replace': {
      const index = info.owners.findIndex(owner => owner.toLowerCase() === change.owner.toLowerCase())
      if (index < 0) return yield* safeError('The address to replace is not a Safe owner.')
      yield* validateOwners(info.owners.map((owner, i) => i === index ? change.replacement : owner), info.threshold, input.safe)
      const previous = index === 0 ? sentinel : info.owners[index - 1]
      if (!previous) return yield* safeError('Safe owner ordering changed.')
      data = encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner', args: [previous, change.owner, change.replacement] })
      break
    }
    case 'threshold':
      yield* validateOwners(info.owners, change.threshold, input.safe)
      data = encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [BigInt(change.threshold)] })
  }
  const transaction = { chainId: input.chainId, safe: input.safe, to: input.safe, value: '0', data, nonce: info.nonce }
  return { ...transaction, hash: safeTransactionHash(transaction) }
})
