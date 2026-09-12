import { Clock, Effect, Schema } from 'effect'
import { decodeFunctionData, erc20Abi } from 'viem'
import { Address, ChainId, EvmError, Id, Uint } from './model'
import type { Plan } from './model'
import { Store } from './storage'

export const Policy = Schema.Struct({
  name: Id, account: Address, chains: Schema.Array(ChainId), expiresAt: Schema.Number,
  maxFeeWei: Uint, nativeBudgetWei: Uint,
  contracts: Schema.Array(Schema.Struct({ address: Address, selectors: Schema.Array(Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{8}$/))) })),
  tokenBudgets: Schema.Array(Schema.Struct({ token: Address, amount: Uint })),
  recipients: Schema.Array(Address),
  revoked: Schema.Boolean,
})
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
const Reservation = Schema.Struct({ id: Id, native: Uint, token: Schema.NullOr(Address), amount: Uint })
const PolicyRecord = Schema.Struct({ policy: Policy, reservations: Schema.Array(Reservation) })

export const savePolicy = Effect.fn('Policy.save')(function* (policy: Policy) {
  const store = yield* Store
  yield* store.updateDocument(`policy:${policy.name}`, value => {
    if (value !== null) throw new EvmError({ code: 'InvalidState', message: 'Policies are immutable. Revoke this policy and create a new named policy.', retryable: false })
    return { policy, reservations: [] }
  })
  return policy
})
export const revokePolicy = Effect.fn('Policy.revoke')(function* (name: string) {
  return yield* (yield* Store).updateDocument(`policy:${name}`, value => {
    const record = Schema.decodeUnknownSync(PolicyRecord)(value)
    return { ...record, policy: { ...record.policy, revoked: true } }
  }).pipe(Effect.map(value => Schema.decodeUnknownSync(PolicyRecord)(value).policy))
})
export const policies = Effect.fn('Policy.list')(function* () {
  return (yield* (yield* Store).documents('policy:')).map(value => Schema.decodeUnknownSync(PolicyRecord)(value))
})

export const reservePolicy = Effect.fn('Policy.reserve')(function* (plan: Plan) {
  if (!plan.policy) return
  const now = yield* Clock.currentTimeMillis
  const store = yield* Store
  yield* store.updateDocument(`policy:${plan.policy}`, value => {
    const record = Schema.decodeUnknownSync(PolicyRecord)(value)
    const p = record.policy
    const deny = (message: string): never => { throw new EvmError({ code: 'PolicyDenied', message, retryable: false }) }
    if (p.revoked || now >= p.expiresAt) deny('Execution policy expired or was revoked.')
    if (p.account.toLowerCase() !== plan.account.toLowerCase() || !p.chains.includes(plan.chainId)) deny('Policy does not authorize this account and chain.')
    if (BigInt(plan.gas) * BigInt(plan.gasPrice) + BigInt(plan.l1FeeEstimate ?? '0') > BigInt(p.maxFeeWei)) deny('Transaction exceeds the policy fee limit.')
    const allowed = p.contracts.find(c => c.address.toLowerCase() === plan.to.toLowerCase())
    const recipientAllowed = (address: string) => p.recipients.some(r => r.toLowerCase() === address.toLowerCase())
    let token: Schema.Schema.Type<typeof Address> | null = null
    let amount = '0'
    if (plan.data !== '0x') {
      if (!allowed?.selectors.some(s => s.toLowerCase() === plan.data.slice(0, 10).toLowerCase())) deny('Contract function is outside the execution policy.')
      const decoded = (() => { try { return decodeFunctionData({ abi: erc20Abi, data: plan.data }) } catch { return null } })()
      if (decoded?.functionName === 'transfer' || decoded?.functionName === 'approve') {
        if (!recipientAllowed(decoded.args[0])) deny('Token recipient or allowance spender is outside the policy.')
        token = plan.to; amount = decoded.args[1].toString()
      } else if (decoded?.functionName === 'transferFrom') {
        if (decoded.args[0].toLowerCase() !== plan.account.toLowerCase() || !recipientAllowed(decoded.args[1])) deny('transferFrom source or recipient is outside the policy.')
        token = plan.to; amount = decoded.args[2].toString()
      }
    } else if (!recipientAllowed(plan.to)) deny('Native transfer recipient is outside the policy.')
    if (record.reservations.some(r => r.id === plan.id)) return record
    const nativeUsed = record.reservations.reduce((sum, r) => sum + BigInt(r.native), 0n)
    if (nativeUsed + BigInt(plan.value) > BigInt(p.nativeBudgetWei)) deny('Native spending budget is exhausted.')
    if (token) {
      const budget = p.tokenBudgets.find(b => b.token.toLowerCase() === token.toLowerCase())
      const spent = record.reservations.filter(r => r.token?.toLowerCase() === token.toLowerCase()).reduce((sum, r) => sum + BigInt(r.amount), 0n)
      if (!budget || spent + BigInt(amount) > BigInt(budget.amount)) deny('Token spending or allowance budget is exhausted.')
    }
    return { ...record, reservations: [...record.reservations, { id: plan.id, native: plan.value, token, amount }] }
  })
})
