import * as Schema from 'effect/Schema'

const address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/i))
const hex = Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-f]{2})*$/i))
const quantity = Schema.String.check(Schema.isPattern(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i))
const shortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120), Schema.isPattern(/^[^\p{C}]+$/u))

export const browserWalletRecordSchema = Schema.Struct({
  version: Schema.Literal(1), address, peer: shortText,
})
export type BrowserWalletRecord = typeof browserWalletRecordSchema.Type

export const browserMessageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('authenticate'), token: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('connected'), address, peer: shortText }),
  Schema.Struct({ kind: Schema.Literal('result'), id: Schema.String, hash: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/i)) }),
  Schema.Struct({ kind: Schema.Literal('error'), id: Schema.String, message: Schema.String.check(Schema.isMaxLength(500)), notSubmitted: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal('disconnect') }),
])

export const browserTransactionSchema = Schema.Struct({ from: address, to: address, data: hex, value: quantity })
export type BrowserTransaction = typeof browserTransactionSchema.Type
export type BridgeMessage =
  | { kind: 'ready'; chainId: number; expectedAddress?: string }
  | { kind: 'transaction'; id: string; chainId: number; transaction: BrowserTransaction }
  | { kind: 'disconnect'; message: string }
