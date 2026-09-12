import { Schema } from 'effect'
import { EVMWallet } from '@crossmint/wallets-sdk'
import type { Wallet, Chain } from '@crossmint/wallets-sdk'
import { Address, Hash, Hex, Intent, Uint } from './model'
import type { Plan } from './model'

export const SmartTransaction = Schema.Struct({
  id: Schema.String, status: Schema.Literals(['awaiting-approval', 'pending', 'failed', 'success']),
  ...Intent.fields, hash: Schema.NullOr(Hash), userOperationHash: Hash,
  feeMode: Schema.Literals(['project', 'user-native', 'user-fungible', 'unknown']),
})
export interface SmartTransaction extends Schema.Schema.Type<typeof SmartTransaction> {}
export interface SmartWalletAdapter {
  readonly provider: 'crossmint'
  readonly prepare: (plan: Plan) => Promise<SmartTransaction>
  readonly approve: (id: string, plan: Plan) => Promise<void>
  readonly status: (id: string) => Promise<SmartTransaction>
}
export const CrossmintTransaction = Schema.Struct({
  id: Schema.String, status: SmartTransaction.fields.status,
  params: Schema.Struct({ chain: Schema.String, calls: Schema.Array(Schema.Struct({ to: Address, data: Hex, value: Uint })).check(Schema.isLengthBetween(1, 1)) }),
  onChain: Schema.Struct({ txId: Schema.optionalKey(Schema.NullOr(Hash)), userOperationHash: Hash, userOperation: Schema.Struct({ sender: Address }) }),
  fees: Schema.optionalKey(Schema.Struct({ mode: Schema.Literals(['project', 'user-native', 'user-fungible']) })),
})
export const crossmintChains = new Map<number, string>([[1, 'ethereum'], [8453, 'base'], [84532, 'base-sepolia'], [11155111, 'ethereum-sepolia'], [42161, 'arbitrum'], [10, 'optimism'], [137, 'polygon']])
export function normalizeCrossmintTransaction(tx: Schema.Schema.Type<typeof CrossmintTransaction>, account: string, chainId: number): SmartTransaction {
  const call = tx.params.calls[0]
  if (!call || tx.params.chain !== crossmintChains.get(chainId) || tx.onChain.userOperation.sender.toLowerCase() !== account.toLowerCase()) throw new Error('Crossmint transaction account or chain differs from the connected wallet.')
  return { ...call, chainId, account: Schema.decodeUnknownSync(Address)(account), id: tx.id, status: tx.status, hash: tx.onChain.txId ?? null, userOperationHash: tx.onChain.userOperationHash, feeMode: tx.fees?.mode ?? 'unknown' }
}
export function crossmintAdapter(wallet: Wallet<Chain>, chainId: number): SmartWalletAdapter {
  if (wallet.chain !== crossmintChains.get(chainId)) throw new Error('Crossmint wallet chain does not match the requested chain.')
  const status = async (id: string) => normalizeCrossmintTransaction(Schema.decodeUnknownSync(CrossmintTransaction)(await wallet.transaction(id)), wallet.address, chainId)
  return {
    provider: 'crossmint', status,
    prepare: async plan => {
      if (plan.account.toLowerCase() !== wallet.address.toLowerCase() || plan.chainId !== chainId) throw new Error('Crossmint wallet does not match the transaction plan.')
      const prepared = await EVMWallet.from(wallet).sendTransaction({ to: plan.to, data: plan.data, value: BigInt(plan.value), options: { prepareOnly: true } })
      return await status(prepared.transactionId)
    },
    approve: async (id, plan) => {
      const tx = await status(id)
      if (tx.chainId !== plan.chainId || tx.account.toLowerCase() !== plan.account.toLowerCase() || tx.to.toLowerCase() !== plan.to.toLowerCase() || tx.data.toLowerCase() !== plan.data.toLowerCase() || tx.value !== plan.value || plan.expiresAt <= Date.now()) throw new Error('Crossmint transaction differs from the approved plan or has expired.')
      if (tx.status === 'awaiting-approval') await wallet.approve({ transactionId: id })
    },
  }
}
