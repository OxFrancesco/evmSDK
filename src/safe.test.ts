import { expect, test } from 'bun:test'
import { Schema } from 'effect'
import { commands } from './catalog'
import { forms } from './tui/forms'
import { SafeCreateInput, SafeTransactionInput, SafeTransaction, safeTransactionHash } from './safe'

const safe = '0x1111111111111111111111111111111111111111'
const to = '0x2222222222222222222222222222222222222222'
const transaction = { chainId: 8453, safe, to, value: '1', data: '0x', nonce: '0' } as const

test('Safe proposal digest binds chain, wallet, destination, value, calldata and nonce', () => {
  const hash = safeTransactionHash(transaction)
  for (const changed of [
    { ...transaction, chainId: 1 }, { ...transaction, safe: to }, { ...transaction, to: safe },
    { ...transaction, value: '2' }, { ...transaction, data: '0x1234' as const }, { ...transaction, nonce: '1' }, { ...transaction, operation: 1 },
  ] satisfies ReadonlyArray<Omit<SafeTransaction, 'hash'>>) expect(safeTransactionHash(changed)).not.toBe(hash)
})

test('Safe input decoding rejects malformed integers and hidden authority fields', () => {
  const decode = Schema.decodeUnknownSync(SafeTransactionInput)
  const input = { chainId: 8453, transaction: { ...transaction, hash: safeTransactionHash(transaction) } }
  for (const value of ['-1', '1.2', 'invalid', (2n ** 256n).toString()]) {
    expect(() => decode({ ...input, transaction: { ...input.transaction, value } })).toThrow()
  }
  expect(() => decode({ ...input, transaction: { ...input.transaction, operation: 2 } }, { onExcessProperty: 'error' })).toThrow()
  expect(() => Schema.decodeUnknownSync(SafeCreateInput)({ chainId: 8453, owners: [], threshold: 0, saltNonce: '0' })).toThrow()
})

test('every Safe command publishes an input, result and TUI form', () => {
  const safeCommands = commands.filter(command => command.name.startsWith('safe-'))
  expect(safeCommands.length).toBeGreaterThanOrEqual(30)
  for (const command of safeCommands) {
    expect(command.outputSchema.schema).not.toEqual(false)
    expect(forms.get(command.name)?.length).toBeGreaterThan(0)
  }
})
