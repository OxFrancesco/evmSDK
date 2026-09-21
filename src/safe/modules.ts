import { Effect, Schema } from 'effect'
import { encodeFunctionData, zeroAddress } from 'viem'
import { Address, Id, publicOperation } from '../model'
import { prepare } from '../execution'
import { Network, rpc } from '../network'
import { decodeSafe, safeAbi, safeError, sentinel } from './contracts'
import { allowanceAbi, extension, verifyModule } from './module-contracts'
import { SafeTarget, SafeUint } from './model'
import { safeInfo } from './wallet'
import { safeBatchPropose } from './batch'
import { safePropose } from './transactions'

const uint96 = SafeUint.check(Schema.makeFilter(value => BigInt(value) < 2n ** 96n || 'Value exceeds uint96'))
export const SafeModuleInput = Schema.Struct({ ...SafeTarget.fields, module: Address, enabled: Schema.Boolean })
export const SafeBudgetTarget = Schema.Struct({ ...SafeTarget.fields, delegate: Address, token: Address })
export const SafeBudgetInput = Schema.Struct({ ...SafeBudgetTarget.fields, amount: uint96, resetMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })) })
export const SafeBudgetSpendInput = Schema.Struct({ ...SafeTarget.fields, account: Address, token: Address, to: Address, amount: uint96, key: Id })
export const SafeBudget = Schema.Struct({ ...SafeBudgetTarget.fields, module: Address, enabled: Schema.Boolean, amount: SafeUint, spent: SafeUint, remaining: SafeUint, resetMinutes: Schema.Number, lastResetMinutes: SafeUint, nonce: SafeUint })

export const safeModulePropose = Effect.fn('Safe.modulePropose')(function* (raw: typeof SafeModuleInput.Type) {
  const input = yield* decodeSafe(SafeModuleInput, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const index = info.modules.findIndex(address => address.toLowerCase() === input.module.toLowerCase())
  if (input.enabled === (index >= 0)) return yield* safeError('Module already has the requested state.')
  yield* verifyModule(input.chainId, input.safe, input.module, BigInt(info.block))
  const previous = index === 0 ? sentinel : info.modules[index - 1]
  if (!input.enabled && !previous) return yield* safeError('Module ordering changed.')
  const data = input.enabled ? encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [input.module] }) : encodeFunctionData({ abi: safeAbi, functionName: 'disableModule', args: [previous ?? sentinel, input.module] })
  return yield* safePropose({ chainId: input.chainId, safe: input.safe, to: input.safe, value: '0', data })
})

export const safeBudget = Effect.fn('Safe.budget')(function* (raw: typeof SafeBudgetTarget.Type) {
  const input = yield* decodeSafe(SafeBudgetTarget, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const module = yield* extension(input.chainId, 'allowance')
  const connection = yield* (yield* Network).client(input.chainId)
  const [amount, spent, reset, lastReset, nonce] = yield* rpc(() => connection.readContract({ address: module, abi: allowanceAbi, functionName: 'getTokenAllowance', args: [input.safe, input.delegate, input.token], blockNumber: BigInt(info.block) }))
  return { ...input, module, enabled: info.modules.some(address => address.toLowerCase() === module.toLowerCase()), amount: amount.toString(), spent: spent.toString(), remaining: (amount > spent ? amount - spent : 0n).toString(), resetMinutes: Number(reset), lastResetMinutes: lastReset.toString(), nonce: nonce.toString() }
})

export const safeBudgetPropose = Effect.fn('Safe.budgetPropose')(function* (raw: typeof SafeBudgetInput.Type) {
  const input = yield* decodeSafe(SafeBudgetInput, raw)
  if ([zeroAddress, sentinel, input.safe.toLowerCase()].includes(input.delegate.toLowerCase())) return yield* safeError('Choose a separate nonzero delegate.')
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const module = yield* extension(input.chainId, 'allowance')
  const calls: { to: `0x${string}`; value: string; data: `0x${string}` }[] = []
  if (!info.modules.some(address => address.toLowerCase() === module.toLowerCase())) calls.push({ to: input.safe, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }) })
  calls.push({ to: module, value: '0', data: encodeFunctionData({ abi: allowanceAbi, functionName: 'addDelegate', args: [input.delegate] }) })
  calls.push({ to: module, value: '0', data: encodeFunctionData({ abi: allowanceAbi, functionName: 'setAllowance', args: [input.delegate, input.token, BigInt(input.amount), input.resetMinutes, 0] }) })
  return yield* safeBatchPropose({ chainId: input.chainId, safe: input.safe, calls })
})

export const safeBudgetRevoke = Effect.fn('Safe.budgetRevoke')(function* (raw: typeof SafeBudgetTarget.Type) {
  const input = yield* decodeSafe(SafeBudgetTarget, raw)
  const module = yield* extension(input.chainId, 'allowance')
  return yield* safePropose({ chainId: input.chainId, safe: input.safe, to: module, value: '0', data: encodeFunctionData({ abi: allowanceAbi, functionName: 'deleteAllowance', args: [input.delegate, input.token] }) })
})

export const safeBudgetSpend = Effect.fn('Safe.budgetSpend')(function* (raw: typeof SafeBudgetSpendInput.Type) {
  const input = yield* decodeSafe(SafeBudgetSpendInput, raw)
  const budget = yield* safeBudget({ chainId: input.chainId, safe: input.safe, delegate: input.account, token: input.token })
  if (!budget.enabled || BigInt(input.amount) <= 0n || BigInt(input.amount) > BigInt(budget.remaining) || input.to === zeroAddress) return yield* safeError('Budget is disabled, insufficient, or the transfer is invalid.')
  const data = encodeFunctionData({ abi: allowanceAbi, functionName: 'executeAllowanceTransfer', args: [input.safe, input.token, input.to, BigInt(input.amount), zeroAddress, 0n, input.account, '0x'] })
  return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: budget.module, value: '0', data, key: input.key }))
})

export const SafeModuleTarget = Schema.Struct({ ...SafeTarget.fields, module: Address })
export const safeModuleInfo = Effect.fn('Safe.moduleInfo')(function* (raw: typeof SafeModuleTarget.Type) {
  const input = yield* decodeSafe(SafeModuleTarget, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  yield* verifyModule(input.chainId, input.safe, input.module, BigInt(info.block))
  return { ...input, enabled: info.modules.some(address => address.toLowerCase() === input.module.toLowerCase()) }
})
