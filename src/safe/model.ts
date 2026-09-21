import { Schema } from 'effect'
import { Address, ChainId, Hash, Hex, Id, Uint } from '../model'

const SafeUint = Uint.check(Schema.isMaxLength(78), Schema.makeFilter(value => (/^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 2n ** 256n) || 'Value exceeds uint256'))

export const SafeTarget = Schema.Struct({ chainId: ChainId, safe: Address })
export const SafeOwners = Schema.Struct({
  owners: Schema.Array(Address).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  threshold: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
})
export const SafeCreateInput = Schema.Struct({ ...SafeOwners.fields, chainId: ChainId, saltNonce: SafeUint })
export const SafeDeployInput = Schema.Struct({ ...SafeCreateInput.fields, account: Address, key: Id })
export const SafeInfo = Schema.Struct({ ...SafeTarget.fields, ...SafeOwners.fields, version: Schema.Literal('1.4.1'), nonce: SafeUint, block: Uint })
export interface SafeInfo extends Schema.Schema.Type<typeof SafeInfo> {}
export const SafeProposalInput = Schema.Struct({ ...SafeTarget.fields, to: Address, value: SafeUint, data: Hex })
export const SafeTransaction = Schema.Struct({ ...SafeProposalInput.fields, nonce: SafeUint, hash: Hash })
export interface SafeTransaction extends Schema.Schema.Type<typeof SafeTransaction> {}
export const SafeTransactionInput = Schema.Struct({ chainId: ChainId, transaction: SafeTransaction })
export const SafeApprovalInput = Schema.Struct({ ...SafeTransactionInput.fields, account: Address, key: Id })
export const SafeApprovals = Schema.Struct({ transaction: SafeTransaction, owners: Schema.Array(Address), approved: Schema.Array(Address), threshold: Schema.Int, ready: Schema.Boolean, block: Uint })
export const SafeDeployment = Schema.Struct({ ...SafeCreateInput.fields, safe: Address, factory: Address, singleton: Address, data: Hex, deployed: Schema.Boolean })
export const SafeOwnerChangeInput = Schema.Struct({
  ...SafeTarget.fields,
  change: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('add'), owner: Address, threshold: SafeOwners.fields.threshold }),
    Schema.Struct({ kind: Schema.Literal('remove'), owner: Address, threshold: SafeOwners.fields.threshold }),
    Schema.Struct({ kind: Schema.Literal('threshold'), threshold: SafeOwners.fields.threshold }),
  ]),
})
