import { encodeDeployProxy, predictProxyAddress } from '@gnosis-guild/zodiac'
import { Effect, Schema } from 'effect'
import { encodeFunctionData, numberToHex, zeroAddress } from 'viem'
import { Address, Hash, Hex, Id, publicOperation } from '../model'
import { prepare } from '../execution'
import { Network, rpc } from '../network'
import { decodeSafe, safeAbi, safeError } from './contracts'
import { extension, rolesAbi, verifyRoles } from './module-contracts'
import { SafeTarget, SafeUint } from './model'
import { safeInfo } from './wallet'
import { safeBatchPropose } from './batch'
import { safePropose } from './transactions'

export const SafeRolesDeployInput = Schema.Struct({ ...SafeTarget.fields, saltNonce: SafeUint, account: Address, key: Id })
export const SafeRoleTarget = Schema.Struct({ ...SafeTarget.fields, module: Address, role: Hash, member: Address })
export const SafeRolePermission = Schema.Struct({
  to: Address, selector: Hex.check(Schema.isLengthBetween(10, 10)),
  parameters: Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal('equal'), value: Hash }),
    Schema.Struct({ kind: Schema.Literal('max'), value: SafeUint }),
  ])).check(Schema.isMaxLength(32)),
})
export const SafeRoleGrantInput = Schema.Struct({ ...SafeRoleTarget.fields, permissions: Schema.Array(SafeRolePermission).check(Schema.isMinLength(1), Schema.isMaxLength(16)) })
export const SafeRoleCallInput = Schema.Struct({ ...SafeTarget.fields, module: Address, role: Hash, account: Address, to: Address, data: Hex })
export const SafeRoleExecuteInput = Schema.Struct({ ...SafeRoleCallInput.fields, key: Id })

export const safeRolesDeploy = Effect.fn('Safe.rolesDeploy')(function* (raw: typeof SafeRolesDeployInput.Type) {
  const input = yield* decodeSafe(SafeRolesDeployInput, raw)
  yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  const mastercopy = yield* extension(input.chainId, 'roles')
  const factory = yield* extension(input.chainId, 'rolesFactory')
  const args = { mastercopy, factory, setupArgs: { types: ['address', 'address', 'address'], values: [input.safe, input.safe, input.safe] }, saltNonce: input.saltNonce }
  const module = yield* decodeSafe(Address, predictProxyAddress(args))
  const data = yield* decodeSafe(Hex, encodeDeployProxy(args).data)
  return { ...publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: factory, value: '0', data, key: input.key })), module }
})

export const safeRoleGrant = Effect.fn('Safe.roleGrant')(function* (raw: typeof SafeRoleGrantInput.Type) {
  const input = yield* decodeSafe(SafeRoleGrantInput, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  yield* verifyRoles(input.chainId, input.safe, input.module, BigInt(info.block))
  if (input.member === zeroAddress || input.role === `0x${'0'.repeat(64)}`) return yield* safeError('Member and role must be nonzero.')
  const calls: { to: `0x${string}`; value: string; data: `0x${string}` }[] = []
  if (!info.modules.some(address => address.toLowerCase() === input.module.toLowerCase())) calls.push({ to: input.safe, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [input.module] }) })
  const seen = new Set<string>()
  for (const permission of input.permissions) {
    if ([zeroAddress, input.safe.toLowerCase(), input.module.toLowerCase()].includes(permission.to.toLowerCase())) return yield* safeError('Roles cannot grant access to wallet or module administration.')
    const key = `${permission.to}:${permission.selector}`.toLowerCase()
    if (seen.has(key)) return yield* safeError('Duplicate role target and selector.')
    seen.add(key)
    calls.push({ to: input.module, value: '0', data: encodeFunctionData({ abi: rolesAbi, functionName: 'scopeTarget', args: [input.role, permission.to] }) })
    if (permission.parameters.some(parameter => parameter.kind === 'max' && BigInt(parameter.value) === 2n ** 256n - 1n)) return yield* safeError('A maximum must be less than uint256 max.')
    const conditions: { parent: number; paramType: number; operator: number; compValue: `0x${string}` }[] = [{ parent: 0, paramType: 5, operator: 5, compValue: '0x' }, ...permission.parameters.map(parameter => ({
      parent: 0, paramType: 1, operator: parameter.kind === 'equal' ? 16 : 18,
      compValue: parameter.kind === 'equal' ? parameter.value : numberToHex(BigInt(parameter.value) + 1n, { size: 32 }),
    }))]
    calls.push({ to: input.module, value: '0', data: encodeFunctionData({ abi: rolesAbi, functionName: 'scopeFunction', args: [input.role, permission.to, permission.selector, conditions, 0] }) })
  }
  calls.push({ to: input.module, value: '0', data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [input.member, [input.role], [true]] }) })
  return yield* safeBatchPropose({ chainId: input.chainId, safe: input.safe, calls })
})

export const safeRoleRevoke = Effect.fn('Safe.roleRevoke')(function* (raw: typeof SafeRoleTarget.Type) {
  const input = yield* decodeSafe(SafeRoleTarget, raw)
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  yield* verifyRoles(input.chainId, input.safe, input.module, BigInt(info.block))
  return yield* safePropose({ chainId: input.chainId, safe: input.safe, to: input.module, value: '0', data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [input.member, [input.role], [false]] }) })
})

const roleCall = Effect.fn('Safe.roleCall')(function* (input: typeof SafeRoleCallInput.Type) {
  const info = yield* safeInfo({ chainId: input.chainId, safe: input.safe })
  yield* verifyRoles(input.chainId, input.safe, input.module, BigInt(info.block))
  if (!info.modules.some(address => address.toLowerCase() === input.module.toLowerCase())) return yield* safeError('Roles module is disabled.')
  return encodeFunctionData({ abi: rolesAbi, functionName: 'execTransactionWithRole', args: [input.to, 0n, input.data, 0, input.role, true] })
})
export const safeRoleCheck = Effect.fn('Safe.roleCheck')(function* (raw: typeof SafeRoleCallInput.Type) {
  const input = yield* decodeSafe(SafeRoleCallInput, raw)
  const data = yield* roleCall(input)
  const connection = yield* (yield* Network).client(input.chainId)
  yield* rpc(() => connection.call({ account: input.account, to: input.module, data }))
  return { allowed: true, safe: input.safe, module: input.module, role: input.role }
})
export const safeRoleExecute = Effect.fn('Safe.roleExecute')(function* (raw: typeof SafeRoleExecuteInput.Type) {
  const input = yield* decodeSafe(SafeRoleExecuteInput, raw)
  const data = yield* roleCall(input)
  return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: input.module, value: '0', data, key: input.key }))
})
