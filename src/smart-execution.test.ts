import { expect, test } from 'bun:test'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress } from 'viem'
import { entryPoint07Address } from 'viem/account-abstraction'
import { CrossmintTransaction, normalizeCrossmintTransaction } from './crossmint'
import type { SmartTransaction, SmartWalletAdapter } from './crossmint'
import { Operation, Plan } from './model'
import { runtimeLayer } from './runtime'
import { Store } from './storage'
import { executeSmart, reconcileSmart, resumeSmart } from './smart-execution'

const account = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const hash = `0x${'a'.repeat(64)}`
const plan = Schema.decodeUnknownSync(Plan)({ id: 'smart', key: 'smart', chainId: 84532, account, to: recipient, data: '0x', value: '10', intentHash: hash, fingerprint: hash, createdAt: 0, expiresAt: Date.now() + 600000, simulationBlock: '1', gas: '21000', gasPrice: '1' })
const unsigned: SmartTransaction = { ...plan, id: 'provider-transaction', status: 'awaiting-approval', hash: null, userOperationHash: plan.fingerprint, feeMode: 'project' }
const initial: Operation = { plan, state: { _tag: 'prepared' } }
const recorded: Operation = { ...initial, remote: { provider: 'crossmint', id: unsigned.id, userOperationHash: unsigned.userOperationHash }, state: { _tag: 'walletPending', hash: null, nonce: -1 } }

test('Crossmint boundary rejects hidden calls, mismatched chains and different senders', () => {
  const fixture = { id: unsigned.id, status: 'awaiting-approval', params: { chain: 'base-sepolia', calls: [{ to: recipient, data: '0x', value: '10' }] }, onChain: { userOperationHash: hash, userOperation: { sender: account } } }
  const decode = Schema.decodeUnknownSync(CrossmintTransaction)
  expect(normalizeCrossmintTransaction(decode(fixture), account, 84532).value).toBe('10')
  expect(() => decode({ ...fixture, params: { ...fixture.params, calls: [...fixture.params.calls, ...fixture.params.calls] } })).toThrow()
  expect(() => normalizeCrossmintTransaction(decode(fixture), account, 8453)).toThrow()
  expect(() => normalizeCrossmintTransaction(decode(fixture), recipient, 84532)).toThrow()
})

test('Crossmint persists the provider ID before signing and resumes that ID after a lost response', async () => {
  const runtime = ManagedRuntime.make(runtimeLayer({ database: ':memory:' }))
  let creates = 0, approvals = 0
  let transaction = unsigned
  const adapter: SmartWalletAdapter = {
    provider: 'crossmint', prepare: async () => { creates++; return transaction }, status: async () => transaction,
    approve: async (id, requested) => {
      approvals++
      expect(id).toBe(unsigned.id); expect(requested.fingerprint).toBe(plan.fingerprint)
      const saved = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Store).get(plan.id) }))
      expect(saved.remote?.id).toBe(id)
      if (approvals === 1) throw new Error('Disconnected before provider response')
      transaction = { ...transaction, status: 'pending' }
    },
  }
  try {
    await runtime.runPromise(Effect.gen(function* () { yield* (yield* Store).insert(initial) }))
    expect((await runtime.runPromise(executeSmart(initial, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    const pending = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* Store).get(plan.id) }))
    expect((await runtime.runPromise(resumeSmart(pending, adapter))).state._tag).toBe('walletPending')
    await runtime.runPromise(resumeSmart(pending, adapter))
    expect(creates).toBe(1); expect(approvals).toBe(2)
  } finally { await runtime.dispose() }
})

test('Crossmint rejects changed or expired plans and unsupported fee policies before approval', async () => {
  const runtime = ManagedRuntime.make(runtimeLayer({ database: ':memory:' }))
  let approvals = 0, creates = 0
  const adapter: SmartWalletAdapter = { provider: 'crossmint', prepare: async () => { creates++; return { ...unsigned, value: '1000' } }, status: async () => unsigned, approve: async () => { approvals++ } }
  try {
    expect((await runtime.runPromise(executeSmart(initial, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    expect((await runtime.runPromise(executeSmart({ ...initial, plan: { ...plan, policy: 'restricted' } }, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    expect((await runtime.runPromise(resumeSmart({ ...recorded, plan: { ...plan, expiresAt: 1 } }, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    expect(creates).toBe(1); expect(approvals).toBe(0)
  } finally { await runtime.dispose() }
})

test('Smart-wallet receipt verification requires its EntryPoint event and rolls back reorged inclusion', async () => {
  const event = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)'])
  let sender: `0x${string}` = account
  let emitter: `0x${string}` = entryPoint07Address
  let success = true, present = true
  let canonical = hash
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const input = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number, method: Schema.String }))(await request.json())
    const log = { address: emitter, topics: encodeEventTopics({ abi: event, eventName: 'UserOperationEvent', args: { userOpHash: plan.fingerprint, sender, paymaster: zeroAddress } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [0n, success, 10n, 20n]), blockHash: hash, blockNumber: '0x1', transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false }
    const receipt = { transactionHash: hash, blockHash: hash, blockNumber: '0x1', from: recipient, to: entryPoint07Address, contractAddress: null, cumulativeGasUsed: '0x20', gasUsed: '0x20', effectiveGasPrice: '0x1', logs: [log], logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', transactionIndex: '0x0', type: '0x2' }
    const result = input.method === 'eth_chainId' ? '0x14a34' : input.method === 'eth_getTransactionReceipt' ? present ? receipt : null : input.method === 'eth_getBlockByNumber' ? { hash: canonical, number: '0x1', transactions: [] } : null
    return Response.json({ jsonrpc: '2.0', id: input.id, result })
  } })
  const runtime = ManagedRuntime.make(runtimeLayer({ database: ':memory:', rpcUrl: server.url.toString() }))
  const adapter: SmartWalletAdapter = { provider: 'crossmint', prepare: async () => unsigned, approve: async () => {}, status: async () => ({ ...unsigned, status: 'success', hash: plan.fingerprint }) }
  try {
    await runtime.runPromise(Effect.gen(function* () { yield* (yield* Store).insert(recorded) }))
    const confirmed = await runtime.runPromise(reconcileSmart(recorded, adapter))
    expect(confirmed.state._tag).toBe('confirmed')
    success = false; expect((await runtime.runPromise(reconcileSmart(recorded, adapter))).state._tag).toBe('reverted')
    success = true; sender = recipient
    expect((await runtime.runPromise(reconcileSmart(recorded, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    sender = account; emitter = recipient
    expect((await runtime.runPromise(reconcileSmart(recorded, adapter).pipe(Effect.result)))._tag).toBe('Failure')
    emitter = entryPoint07Address; canonical = `0x${'b'.repeat(64)}`
    expect((await runtime.runPromise(reconcileSmart(confirmed, adapter))).state._tag).toBe('walletPending')
    canonical = hash; present = false
    expect((await runtime.runPromise(reconcileSmart(confirmed, adapter))).state._tag).toBe('walletPending')
  } finally { await runtime.dispose(); await server.stop(true) }
})
