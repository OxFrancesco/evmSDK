import { Schema } from 'effect'
import { Address, ChainId, Hash, Hex, Operation, Plan, Uint, WorkspaceEntry } from './model'
import { BlockSample } from './watch'

export const OperationView = Schema.Struct({ plan: Plan, remote: Operation.fields.remote, state: Schema.TaggedUnion({
  prepared: {}, cancelled: {},
  submitting: { hash: Hash, nonce: Schema.Int }, pending: { hash: Hash, nonce: Schema.Int },
  walletPending: { hash: Schema.NullOr(Hash), nonce: Schema.Int }, superseded: { by: Schema.String },
  confirmed: { hash: Hash, block: Uint, gasUsed: Uint, blockHash: Schema.optionalKey(Hash), finality: Schema.optionalKey(Schema.Literals(['included', 'safe', 'finalized'])) },
  reverted: { hash: Hash, block: Uint, gasUsed: Uint, blockHash: Schema.optionalKey(Hash), finality: Schema.optionalKey(Schema.Literals(['included', 'safe', 'finalized'])) },
}) })
export const BlockView = Schema.Struct({
  chainId: ChainId, number: Schema.NullOr(Uint), hash: Schema.NullOr(Hash), parentHash: Hash,
  timestamp: Uint, gasUsed: Uint, gasLimit: Uint, baseFeePerGas: Schema.NullOr(Uint),
  transactions: Schema.Int,
})
export const InspectView = Schema.Struct({ address: Address, implementation: Schema.NullOr(Address), abi: Schema.Array(Schema.Json), source: Schema.Literals(['provided', 'signatures', 'etherscan']), block: Uint })
export const ReadView = Schema.Struct({ chainId: ChainId, address: Address, block: Uint, value: Schema.Json })
export const BalanceView = Schema.Struct({ chainId: ChainId, address: Address, block: Uint, balanceWei: Uint })
export const TokenView = Schema.Struct({ chainId: ChainId, address: Address, token: Address, block: Uint, symbol: Schema.String, decimals: Schema.Int, amount: Uint })
export const outputSchemas = new Map<string, Schema.Top>([
  ...['prepare', 'prepare-call', 'execute', 'status', 'wait', 'cancel', 'attach-transaction', 'replace', 'transfer', 'approve', 'revoke', 'wrap'].map(name => [name, OperationView] as const),
  ['operations', Schema.Array(OperationView)],
  ['inspect', InspectView],
  ['read', ReadView],
  ['wallet', Schema.Struct({ address: Schema.NullOr(Address), source: Schema.String })],
  ['balance', BalanceView],
  ['token', TokenView],
  ['block', BlockView],
  ['transaction', Schema.Struct({ chainId: ChainId, hash: Hash, from: Address, to: Schema.NullOr(Address), nonce: Schema.Int, valueWei: Uint, data: Hex, block: Schema.NullOr(Uint), gas: Uint, gasPrice: Schema.NullOr(Uint) })],
  ['logs', Schema.Struct({ logs: Schema.Array(Schema.Struct({ address: Address, data: Hex, topics: Schema.Array(Hash), block: Schema.NullOr(Uint), transactionHash: Schema.NullOr(Hash), logIndex: Schema.NullOr(Schema.Int), removed: Schema.Boolean })), fromBlock: Uint, toBlock: Uint, nextBlock: Schema.NullOr(Uint), nextOffset: Schema.Int })],
  ['workspace', Schema.Array(WorkspaceEntry)], ['save', WorkspaceEntry], ['remove', Schema.Struct({ removed: Schema.String })],
  ['watch', Schema.Array(BlockSample)],
])
