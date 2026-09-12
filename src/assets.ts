import { Effect, Schema } from 'effect'
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, parseUnits, formatUnits } from 'viem'
import { Address, ChainId, EvmError, Id, Uint, publicOperation } from './model'
import { Network, rpc } from './network'
import { prepare } from './execution'
import { createWorkflow } from './workflows'

export const AssetAction = Schema.Struct({ chainId: ChainId, account: Address, token: Schema.optionalKey(Address), to: Address, amount: Uint, key: Id, policy: Schema.optionalKey(Id) })
export const AllowanceAction = Schema.Struct({ chainId: ChainId, account: Address, token: Address, spender: Address, amount: Uint, key: Id, policy: Schema.optionalKey(Id) })
export const transfer = Effect.fn('Assets.transfer')(function* (input: Schema.Schema.Type<typeof AssetAction>) {
  const op = yield* prepare({ chainId: input.chainId, account: input.account, key: input.key, policy: input.policy, to: input.token ?? input.to, data: input.token ? encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [input.to, BigInt(input.amount)] }) : '0x', value: input.token ? '0' : input.amount })
  return publicOperation(op)
})
export const approve = Effect.fn('Assets.approve')(function* (input: Schema.Schema.Type<typeof AllowanceAction>) {
  return publicOperation(yield* prepare({ ...input, to: input.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.spender, BigInt(input.amount)] }), value: '0' }))
})
export const AllowanceInput = Schema.Struct({ chainId: ChainId, account: Address, token: Address, spender: Address })
export const allowance = Effect.fn('Assets.allowance')(function* (input: Schema.Schema.Type<typeof AllowanceInput>) {
  const client = yield* (yield* Network).client(input.chainId)
  const block = yield* rpc(() => client.getBlockNumber())
  const amount = yield* rpc(() => client.readContract({ address: input.token, abi: erc20Abi, functionName: 'allowance', args: [input.account, input.spender], blockNumber: block }))
  return { ...input, block: block.toString(), amount: amount.toString() }
})
export const WrapInput = Schema.Struct({ chainId: ChainId, account: Address, wrapper: Address, amount: Uint, key: Id, policy: Schema.optionalKey(Id), action: Schema.Literals(['wrap', 'unwrap']) })
export const wrap = Effect.fn('Assets.wrap')(function* (input: Schema.Schema.Type<typeof WrapInput>) {
  const abi = parseAbi(['function deposit() payable', 'function withdraw(uint256 amount)'])
  return publicOperation(yield* prepare({ ...input, to: input.wrapper, data: input.action === 'wrap' ? encodeFunctionData({ abi, functionName: 'deposit' }) : encodeFunctionData({ abi, functionName: 'withdraw', args: [BigInt(input.amount)] }), value: input.action === 'wrap' ? input.amount : '0' }))
})
export const UnitsInput = Schema.Struct({ amount: Schema.String.check(Schema.isPattern(/^\d+(\.\d+)?$/)), decimals: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })) })
export const units = Effect.fn('Assets.units')(function* (input: Schema.Schema.Type<typeof UnitsInput>) {
  if ((input.amount.split('.')[1]?.length ?? 0) > input.decimals) return yield* new EvmError({ code: 'InvalidInput', message: 'Amount has more fractional digits than this token supports.', retryable: false })
  const baseUnits = parseUnits(input.amount, input.decimals)
  return { baseUnits: baseUnits.toString(), decimal: formatUnits(baseUnits, input.decimals), decimals: input.decimals }
})
const vaultAbi = parseAbi(['function asset() view returns(address)', 'function balanceOf(address) view returns(uint256)', 'function convertToAssets(uint256) view returns(uint256)', 'function previewDeposit(uint256) view returns(uint256)', 'function previewRedeem(uint256) view returns(uint256)', 'function deposit(uint256,address) returns(uint256)', 'function redeem(uint256,address,address) returns(uint256)'])
export const VaultInput = Schema.Struct({ chainId: ChainId, account: Address, vault: Address, amount: Uint, action: Schema.Literals(['deposit', 'redeem']), key: Id, policy: Schema.optionalKey(Id) })
export const vault = Effect.fn('Vault.prepare')(function* (input: Schema.Schema.Type<typeof VaultInput>) {
  const client = yield* (yield* Network).client(input.chainId)
  const asset = yield* rpc(() => client.readContract({ address: input.vault, abi: vaultAbi, functionName: 'asset' }))
  const preview = yield* rpc(() => client.readContract({ address: input.vault, abi: vaultAbi, functionName: input.action === 'deposit' ? 'previewDeposit' : 'previewRedeem', args: [BigInt(input.amount)] }))
  const to = input.action === 'deposit' ? input.vault : asset
  const before = yield* rpc(() => client.readContract({ address: to, abi: erc20Abi, functionName: 'balanceOf', args: [input.account] }))
  const base = { chainId: input.chainId, account: input.account, key: input.key, policy: input.policy, value: '0' }
  const approvals = input.action === 'deposit' ? [{ label: 'Approve vault assets', intent: { ...base, to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.vault, BigInt(input.amount)] }) } }] : []
  const data = input.action === 'deposit' ? encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [BigInt(input.amount), input.account] }) : encodeFunctionData({ abi: vaultAbi, functionName: 'redeem', args: [BigInt(input.amount), input.account, input.account] })
  return yield* createWorkflow({ key: input.key, steps: [...approvals, { label: `${input.action} vault`, intent: { ...base, to: input.vault, data }, check: { call: { chainId: input.chainId, address: to, signatures: ['function balanceOf(address) view returns(uint256)'], functionName: 'balanceOf', args: [input.account] }, comparison: 'atLeast', expected: (before + preview).toString() } }] })
})
export const LendingInput = Schema.Struct({ chainId: ChainId, account: Address, pool: Address, asset: Address, amount: Uint, action: Schema.Literals(['supply', 'withdraw']), key: Id, policy: Schema.optionalKey(Id) })
export const lending = Effect.fn('Lending.prepare')(function* (input: Schema.Schema.Type<typeof LendingInput>) {
  const abi = parseAbi(['function supply(address,uint256,address,uint16)', 'function withdraw(address,uint256,address) returns(uint256)'])
  const base = { chainId: input.chainId, account: input.account, key: input.key, policy: input.policy, value: '0' }
  const approval = { label: 'Approve lending pool', intent: { ...base, to: input.asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [input.pool, BigInt(input.amount)] }) } }
  const data = input.action === 'supply' ? encodeFunctionData({ abi, functionName: 'supply', args: [input.asset, BigInt(input.amount), input.account, 0] }) : encodeFunctionData({ abi, functionName: 'withdraw', args: [input.asset, BigInt(input.amount), input.account] })
  return yield* createWorkflow({ key: input.key, steps: [...(input.action === 'supply' ? [approval] : []), { label: `${input.action} lending pool`, intent: { ...base, to: input.pool, data } }] })
})
export const describeCalldata = (data: `0x${string}`) => {
  try { const call = decodeFunctionData({ abi: erc20Abi, data }); return { functionName: call.functionName, args: call.args?.map(String) ?? [] } } catch { return null }
}
