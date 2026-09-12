import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, custom, type Hex } from 'viem'
import { createFileJournalStore } from '../execution-journal'
import { createExecutionPlan, type ExecutionStepState } from '../send'
import { reconcileAlmCycle, recoveredPositionState, resolveAlmCycle } from './recovery'
import { acquireAlmStateLock, checkRebalanceGate, loadAlmState, managedPositionId, positionStateKey, saveAlmState, type AlmCycle } from './state'

const wallet = '0x1000000000000000000000000000000000000001'
const pool = '0x2000000000000000000000000000000000000002'
const hash: Hex = `0x${'1'.repeat(64)}`
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(steps: ExecutionStepState[] = [{ kind: 'submitted', hash }]) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-recovery-test-'))
  directories.push(directory)
  const path = join(directory, 'state.json')
  const store = createFileJournalStore(join(directory, 'executions'))
  const plan = createExecutionPlan({ chainId: 8453, sender: wallet, steps: steps.map(() => ({ role: 'action', transaction: { from: wallet, to: pool, data: '0x', value: 0n } })) })
  store.save({ plan, status: 'active', steps })
  const cycle: AlmCycle = { id: crypto.randomUUID(), kind: 'rebalance', chain: 8453, wallet, pool, positionId: '42', tickLower: 0, tickUpper: 1_000, startedAt: Date.now(), balances: { token0: '100', token1: '200' }, phases: [{ name: 'withdraw', executionId: plan.id }], status: { kind: 'active' } }
  const key = positionStateKey(8453, pool, wallet)
  return { path, store, plan, cycle, key }
}

function receiptClient(outcome: 'success' | 'reverted' | 'pending', chain = 8453) {
  return createPublicClient({ transport: custom({ request: async ({ method }) => {
    if (method === 'eth_chainId') return `0x${chain.toString(16)}`
    if (method !== 'eth_getTransactionReceipt') throw new Error(`Unexpected RPC method ${method}`)
    if (outcome === 'pending') return null
    return { transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: '0x1', from: wallet, to: pool, cumulativeGasUsed: '0x1', gasUsed: '0x1', contractAddress: null, logs: [], logsBloom: '0x', status: outcome === 'success' ? '0x1' : '0x0', effectiveGasPrice: '0x1', type: '0x2' }
  } }) })
}

describe('ALM safety state', () => {
  test('atomically persists cycle identity, balances and attempt limits with private permissions', () => {
    const f = fixture()
    const state = { [f.key]: { rebalances: [f.cycle.startedAt], cycle: f.cycle } }
    saveAlmState(state, f.path)
    expect(loadAlmState(f.path)).toEqual(state)
    expect(statSync(f.path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(state)
    expect(checkRebalanceGate(state[f.key], Date.now(), 0, 4).allowed).toBe(false)
  })

  test('does not silently reset caps or discard a malformed cycle', () => {
    const f = fixture()
    for (const contents of ['{broken', '[]', JSON.stringify({ [f.key]: { rebalances: ['bad'] } }), JSON.stringify({ [f.key]: { rebalances: [], cycle: {} } })]) {
      writeFileSync(f.path, contents)
      expect(() => loadAlmState(f.path)).toThrow('Invalid ALM safety state')
    }
  })

  test('keeps legacy caps readable and separates new wallet identities', () => {
    const f = fixture()
    const legacy = { [positionStateKey(8453, pool)]: { rebalances: [1_000] } }
    saveAlmState(legacy, f.path)
    expect(loadAlmState(f.path)).toEqual(legacy)
    expect(positionStateKey(8453, pool, wallet)).not.toBe(positionStateKey(8453, pool, pool))
  })

  test('holds an exclusive lock and never steals one', () => {
    const f = fixture()
    const release = acquireAlmStateLock(f.path)
    expect(() => acquireAlmStateLock(f.path)).toThrow('locked')
    release()
    acquireAlmStateLock(f.path)()
  })
})

describe('ALM receipt-only recovery', () => {
  test('confirms a known hash without replaying or clearing the cycle', async () => {
    const f = fixture()
    const journals = await reconcileAlmCycle(f.cycle, f.store, receiptClient('success'))
    expect(journals[0].steps).toEqual([{ kind: 'confirmed', hash }])
    expect(journals[0].status).toBe('complete')
    expect(f.cycle.status.kind).toBe('active')
    expect(resolveAlmCycle(f.cycle, journals, f.store, 'Funds verified and position rebuilt')).toMatchObject({ status: { kind: 'resolved' } })
  })

  test('preserves unknown and pending submissions and refuses resolution', async () => {
    for (const step of [{ kind: 'submitting' }, { kind: 'submitted', hash }] satisfies ExecutionStepState[]) {
      const f = fixture([step])
      const journals = await reconcileAlmCycle(f.cycle, f.store, receiptClient('pending'))
      expect(journals[0].steps).toEqual([step])
      expect(() => resolveAlmCycle(f.cycle, journals, f.store, 'reviewed')).toThrow('unknown or pending')
    }
  })

  test('records a reverted receipt without treating the cycle as successful', async () => {
    const f = fixture()
    const journals = await reconcileAlmCycle(f.cycle, f.store, receiptClient('reverted'))
    expect(journals[0].status).toBe('failed')
    expect(journals[0].steps).toEqual([{ kind: 'reverted', hash }])
    expect(f.cycle.status.kind).toBe('active')
  })

  test('cancels unsubmitted remainder only after explicit manual recovery', async () => {
    const f = fixture([{ kind: 'submitted', hash }, { kind: 'ready' }])
    const journals = await reconcileAlmCycle(f.cycle, f.store, receiptClient('success'))
    expect(() => resolveAlmCycle(f.cycle, journals, f.store, ' ')).toThrow('note')
    const resolved = resolveAlmCycle(f.cycle, journals, f.store, 'Position restored manually')
    expect(resolved.status).toEqual({ kind: 'resolved', note: 'Position restored manually' })
    expect(f.store.load(f.plan.id)?.status).toBe('cancelled')
    expect(f.store.load(f.plan.id)?.steps[1].kind).toBe('ready')
  })

  test('rechecks journal state under lock rather than trusting a stale reconciliation', async () => {
    const f = fixture([{ kind: 'ready' }])
    const journals = await reconcileAlmCycle(f.cycle, f.store, receiptClient('pending'))
    f.store.save({ plan: f.plan, status: 'active', steps: [{ kind: 'submitting' }] })
    expect(() => resolveAlmCycle(f.cycle, journals, f.store, 'reviewed')).toThrow('unknown or pending')
  })

  test('rejects mismatched chain or wallet bindings and missing journals', async () => {
    const f = fixture()
    await expect(reconcileAlmCycle(f.cycle, f.store, receiptClient('success', 10))).rejects.toThrow('chain')
    await expect(reconcileAlmCycle({ ...f.cycle, wallet: pool }, f.store, receiptClient('success'))).rejects.toThrow('identities')
    await expect(reconcileAlmCycle({ ...f.cycle, phases: [{ name: 'withdraw', executionId: crypto.randomUUID() }] }, f.store, receiptClient('success'))).rejects.toThrow('Missing execution journal')
  })
})

test('manual recovery persists the replacement NFT for the next daemon run', async () => {
  const f = fixture()
  const cycle = { ...f.cycle, resultPositionId: '43' }
  const journals = await reconcileAlmCycle(cycle, f.store, receiptClient('success'))
  const entry = { configuredPositionId: '42', managedPositionId: '42', rebalances: [cycle.startedAt], cycle }
  const resolved = resolveAlmCycle(cycle, journals, f.store, 'Replacement NFT verified')
  saveAlmState({ [f.key]: recoveredPositionState(entry, resolved, 43n) }, f.path)
  expect(managedPositionId(loadAlmState(f.path)[f.key], 42n)).toBe(43n)
  expect(loadAlmState(f.path)[f.key].rebalances).toEqual(entry.rebalances)
  expect(managedPositionId(recoveredPositionState(entry, resolved, 44n), 42n)).toBe(44n)
  expect(() => recoveredPositionState(entry, cycle, 43n)).toThrow('Resolve')
})
