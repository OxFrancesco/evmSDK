import { Schema } from 'effect'

export const Address = Schema.TemplateLiteral(['0x', Schema.String]).check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/))
export const Hex = Schema.TemplateLiteral(['0x', Schema.String]).check(Schema.isPattern(/^0x(?:[0-9a-fA-F]{2})*$/))
export const Hash = Schema.TemplateLiteral(['0x', Schema.String]).check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/))
export const Uint = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))
export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/))
export const ChainId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

export class EvmError extends Schema.TaggedError<EvmError>()('EvmError', {
  code: Schema.Literals(['InvalidInput', 'RpcError', 'ChainMismatch', 'AbiUnavailable', 'SimulationReverted',
    'ApprovalRequired', 'SignerInteractionRequired', 'AccountMismatch', 'PlanExpired', 'NotFound',
    'IdempotencyConflict', 'AccountBusy', 'StorageError', 'SubmissionUncertain', 'InvalidState',
    'PolicyDenied', 'ProviderUnavailable', 'QuoteExpired', 'OutcomeMismatch', 'CapabilityUnavailable']),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export const Target = Schema.Struct({ chainId: ChainId })
export const ContractInput = Schema.Struct({
  ...Target.fields,
  address: Address,
  block: Schema.optionalKey(Uint),
  abi: Schema.optionalKey(Schema.Array(Schema.Json)),
  signatures: Schema.optionalKey(Schema.Array(Schema.String)),
})
export const CallInput = Schema.Struct({
  ...ContractInput.fields,
  functionName: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.Json)),
  account: Schema.optionalKey(Address),
})
export interface CallInput extends Schema.Schema.Type<typeof CallInput> {}

export const Intent = Schema.Struct({
  chainId: ChainId, account: Address, to: Address, data: Hex, value: Uint,
})
export interface Intent extends Schema.Schema.Type<typeof Intent> {}
export const PrepareInput = Schema.Struct({
  ...Intent.fields,
  key: Id,
  deadline: Schema.optionalKey(Schema.Number),
  policy: Schema.optionalKey(Id),
})
export interface PrepareInput extends Schema.Schema.Type<typeof PrepareInput> {}
export const PrepareCallInput = Schema.Struct({
  ...CallInput.fields, account: Address, value: Uint, key: Id,
  policy: Schema.optionalKey(Id), deadline: Schema.optionalKey(Schema.Number),
})
export const Plan = Schema.Struct({
  ...PrepareInput.fields, id: Id, intentHash: Hash, fingerprint: Hash, createdAt: Schema.Number,
  expiresAt: Schema.Number, simulationBlock: Uint, gas: Uint, gasPrice: Uint,
  feeType: Schema.optionalKey(Schema.Literals(['legacy', 'eip1559'])),
  maxPriorityFeePerGas: Schema.optionalKey(Uint),
  l1FeeEstimate: Schema.optionalKey(Uint),
  replacement: Schema.optionalKey(Schema.Struct({ id: Id, nonce: Schema.Int })),
})
export interface Plan extends Schema.Schema.Type<typeof Plan> {}
export const Operation = Schema.Struct({
  plan: Plan,
  remote: Schema.optionalKey(Schema.Struct({ provider: Schema.Literal('crossmint'), id: Schema.String, userOperationHash: Hash })),
  signed: Schema.optionalKey(Schema.Struct({ raw: Hex, hash: Hash, nonce: Schema.Int })),
  state: Schema.TaggedUnion({
    prepared: {},
    cancelled: {},
    submitting: { hash: Hash, raw: Hex, nonce: Schema.Int },
    pending: { hash: Hash, raw: Hex, nonce: Schema.Int },
    walletPending: { hash: Schema.NullOr(Hash), nonce: Schema.Int },
    confirmed: { hash: Hash, block: Uint, gasUsed: Uint, blockHash: Schema.optionalKey(Hash), finality: Schema.optionalKey(Schema.Literals(['included', 'safe', 'finalized'])) },
    reverted: { hash: Hash, block: Uint, gasUsed: Uint, blockHash: Schema.optionalKey(Hash), finality: Schema.optionalKey(Schema.Literals(['included', 'safe', 'finalized'])) },
    superseded: { by: Id },
  }),
})
export interface Operation extends Schema.Schema.Type<typeof Operation> {}
export const ExecuteInput = Schema.Struct({
  id: Id,
  approval: Schema.TaggedUnion({ yolo: {}, approved: { fingerprint: Hash }, required: {} }),
})
export interface ExecuteInput extends Schema.Schema.Type<typeof ExecuteInput> {}
export const WorkspaceEntry = Schema.Struct({ name: Id, chainId: ChainId, address: Address })
export interface WorkspaceEntry extends Schema.Schema.Type<typeof WorkspaceEntry> {}

export function publicOperation(operation: Operation) {
  const state = operation.state
  if (state._tag === 'submitting' || state._tag === 'pending') {
    return { plan: operation.plan, state: { _tag: state._tag, hash: state.hash, nonce: state.nonce } }
  }
  return { plan: operation.plan, remote: operation.remote, state }
}
