import { getMultiSendCallOnlyDeployment } from '@safe-global/safe-deployments'
import { Effect } from 'effect'
import { concatHex, decodeFunctionData, encodeFunctionData, numberToHex, parseAbi, size, sliceHex, zeroAddress } from 'viem'
import { Address, type EvmError } from '../model'
import { Network, rpc } from '../network'
import { decodeSafe, safeAbi, safeError, verifyCode } from './contracts'
import { SafeBatchInput, type SafeTransaction } from './model'
import { extension, verifyModule } from './module-contracts'
import { safePropose } from './transactions'

export const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable'])
export const multiSend = Effect.fn('Safe.multiSend')(function* (chainId: number) {
  const deployment = getMultiSendCallOnlyDeployment({ version: '1.4.1', network: chainId === 31337 ? undefined : String(chainId) })?.deployments.canonical
  if (!deployment) return yield* safeError('No supported MultiSendCallOnly deployment on this chain.')
  const address = yield* decodeSafe(Address, deployment.address)
  const connection = yield* (yield* Network).client(chainId)
  yield* verifyCode(chainId, address, deployment.codeHash, yield* rpc(() => connection.getBlockNumber()))
  return address
})

export function decodeSafeBatch(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: multiSendAbi, data })
  if (encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: decoded.args }).toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical batch encoding')
  const bytes = decoded.args[0]
  const calls: { to: `0x${string}`; value: string; data: `0x${string}` }[] = []
  let offset = 0
  while (offset < size(bytes)) {
    if (calls.length >= 64 || size(bytes) - offset < 85 || sliceHex(bytes, offset, offset + 1) !== '0x00') throw new Error('Invalid batch or delegated inner call')
    const to = sliceHex(bytes, offset + 1, offset + 21)
    const value = BigInt(sliceHex(bytes, offset + 21, offset + 53)).toString()
    const length = BigInt(sliceHex(bytes, offset + 53, offset + 85))
    if (length > BigInt(size(bytes) - offset - 85) || to === zeroAddress) throw new Error('Invalid batch call')
    const end = offset + 85 + Number(length)
    calls.push({ to, value, data: length === 0n ? '0x' : sliceHex(bytes, offset + 85, end) })
    offset = end
  }
  if (!calls.length) throw new Error('Empty batch')
  return calls
}

export const validateSafeCall: (tx: Pick<SafeTransaction, 'chainId' | 'safe' | 'to' | 'value' | 'data' | 'operation'>) => Effect.Effect<void, EvmError, Network> = Effect.fn('Safe.validateCall')(function* (tx: Pick<SafeTransaction, 'chainId' | 'safe' | 'to' | 'value' | 'data' | 'operation'>) {
  if ((tx.operation ?? 0) === 0) {
    if (tx.to.toLowerCase() !== tx.safe.toLowerCase() || tx.data === '0x') return
    const decoded = yield* Effect.try({ try: () => decodeFunctionData({ abi: safeAbi, data: tx.data }), catch: () => safeError('Unsupported Safe administration call.') })
    if (decoded.functionName === 'enableModule') {
      const connection = yield* (yield* Network).client(tx.chainId)
      yield* verifyModule(tx.chainId, tx.safe, decoded.args[0], yield* rpc(() => connection.getBlockNumber()))
    }
    if (decoded.functionName === 'setFallbackHandler' && decoded.args[0] !== zeroAddress) {
      const handler = yield* extension(tx.chainId, 'erc4337')
      if (decoded.args[0].toLowerCase() !== handler.toLowerCase()) return yield* safeError('Unsupported Safe fallback handler.')
    }
    return
  }
  const target = yield* multiSend(tx.chainId)
  if (tx.value !== '0' || tx.to.toLowerCase() !== target.toLowerCase()) return yield* safeError('Delegatecall is restricted to the official MultiSendCallOnly contract with zero outer value.')
  const calls = yield* Effect.try({ try: () => decodeSafeBatch(tx.data), catch: () => safeError('Invalid CALL-only Safe batch.') })
  for (const call of calls) yield* validateSafeCall({ ...tx, ...call, operation: 0 })
})

export const safeBatchPropose = Effect.fn('Safe.batchPropose')(function* (raw: typeof SafeBatchInput.Type) {
  const input = yield* decodeSafe(SafeBatchInput, raw)
  if (input.calls.some(call => call.to === zeroAddress)) return yield* safeError('Batch destinations cannot be zero.')
  const to = yield* multiSend(input.chainId)
  const transactions = concatHex(input.calls.map(call => concatHex(['0x00', call.to, numberToHex(BigInt(call.value), { size: 32 }), numberToHex(size(call.data), { size: 32 }), call.data])))
  return yield* safePropose({ chainId: input.chainId, safe: input.safe, to, value: '0', operation: 1, data: encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [transactions] }) })
})
