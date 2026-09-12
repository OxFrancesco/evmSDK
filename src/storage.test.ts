import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { Address, Hex, Operation, PrepareInput } from './model'
import { Store, storeLayer } from './storage'

const address = '0x1111111111111111111111111111111111111111'
const hash = `0x${'a'.repeat(64)}`
const operation = Schema.decodeUnknownSync(Operation)({ plan: {
  id: 'plan', key: 'one', chainId: 31337, account: address, to: address, data: '0x', value: '0',
  intentHash: hash, fingerprint: hash, createdAt: 0, expiresAt: 600_000, simulationBlock: '1', gas: '25200', gasPrice: '1000',
}, state: { _tag: 'prepared' } })

test('wire input rejects malformed addresses, calldata, and unsafe numeric values', () => {
  expect(Schema.is(Address)('0x123')).toBe(false)
  expect(Schema.is(Hex)('0xabc')).toBe(false)
  expect(Schema.is(PrepareInput)({ ...operation.plan, value: 1 })).toBe(false)
  expect(Schema.is(PrepareInput)({ ...operation.plan, value: '-1' })).toBe(false)
  expect(Schema.is(PrepareInput)({ ...operation.plan, chainId: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
})

test('corrupt persisted operations fail visibly instead of appearing empty', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'evm-storage-')), 'operations.sqlite')
  const runtime = ManagedRuntime.make(storeLayer(path))
  try {
    await runtime.runPromise(Effect.gen(function* () { yield* (yield* Store).insert(operation) }))
    const connection = new Database(path)
    connection.query('UPDATE operations SET body = ?').run('{broken')
    connection.close()
    const result = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Store).list() }).pipe(Effect.result))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.code).toBe('StorageError')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally { await runtime.dispose() }
})

test('one process cannot acquire an account lock twice', async () => {
  const runtime = ManagedRuntime.make(storeLayer(':memory:'))
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* Store
      yield* store.insert(operation)
      yield* store.lock(operation)
      const collision = yield* store.lock(operation).pipe(Effect.result)
      expect(collision._tag).toBe('Failure')
      if (collision._tag === 'Failure') expect(collision.failure.code).toBe('AccountBusy')
      yield* store.unlock(operation)
      yield* store.lock(operation)
      yield* store.unlock(operation)
    }))
  } finally { await runtime.dispose() }
})
