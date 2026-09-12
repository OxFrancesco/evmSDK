import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { createExecutionPlan, renderPlanSummary, sendPlan, type ExecutionJournal, type PlanJournalStore, type SendPlanOptions } from './send'

const owner: Address = '0x1111111111111111111111111111111111111111'
const target: Address = '0x2222222222222222222222222222222222222222'
const hash: Hex = `0x${'1'.repeat(64)}`
const plan = () => createExecutionPlan({ chainId: 8453, sender: owner, steps: [{ role: 'action', transaction: { from: owner, to: target, data: '0x', value: 1n } }] })

function memoryStore(): PlanJournalStore {
  const entries = new Map<string, ExecutionJournal>()
  return {
    load: (id) => entries.get(id),
    save: (entry) => { entries.set(entry.plan.id, structuredClone(entry)) },
    list: () => [...entries.values()],
    acquire: () => () => {},
  }
}

describe('confirmed plan execution', () => {
  test('identifies both namesake assets in the shared CLI and TUI confirmation', () => {
    const summary = renderPlanSummary('swap', { quote: {
      from_token: { symbol: 'USDC', address: owner },
      to_token: { symbol: 'USDC', address: target },
      amount_in_decimal: '1', amount_out_decimal: '1', min_amount_out_decimal: '0.99', slippage: 0.01,
    } }, [])
    expect(summary).toContain(`from asset: ${owner}`)
    expect(summary).toContain(`to asset: ${target}`)
  })

  test('identifies both assets in liquidity confirmations', () => {
    for (const action of ['deposit', 'withdraw'] as const) {
      const summary = renderPlanSummary(action, { [action === 'deposit' ? 'deposit' : 'withdrawal']: {
        pool: { token0: 'USDC', token1: 'USDC', token0_address: owner, token1_address: target },
        amount0_decimal: 1, amount1_decimal: 1,
      } }, [])
      expect(summary).toContain(`token0 asset: ${owner}`)
      expect(summary).toContain(`token1 asset: ${target}`)
    }
  })

  test('rejects a wrong sender and an expired plan before sending', async () => {
    const signer = { address: target, describe: 'test', send: async () => { throw new Error('must not send') } }
    await expect(sendPlan({ plan: plan(), signer, store: memoryStore() })).rejects.toThrow('sender')
    const expired = createExecutionPlan({ ...plan(), expiresAt: 1 })
    await expect(sendPlan({ plan: expired, signer: { ...signer, address: owner }, store: memoryStore() })).rejects.toThrow('expired')
  })

  test('reconciles an unknown receipt without submitting the transaction twice', async () => {
    const execution = plan()
    const store = memoryStore()
    let submissions = 0
    let unavailable = true
    const options = {
      plan: execution,
      store,
      signer: { address: owner, describe: 'test', send: async () => { submissions++; return hash } },
      publicClient: { waitForTransactionReceipt: async () => {
        if (unavailable) throw new Error('RPC unavailable')
        return { status: 'success', blockNumber: 1n, transactionHash: hash }
      } },
      log: () => {},
    } satisfies SendPlanOptions
    await expect(sendPlan(options)).rejects.toThrow('unknown')
    unavailable = false
    expect(await sendPlan(options)).toEqual([hash])
    expect(await sendPlan(options)).toEqual([hash])
    expect(submissions).toBe(1)
  })

  test('does not count a successful replacement or cancellation as the planned transaction', async () => {
    const store = memoryStore()
    const execution = plan()
    await expect(sendPlan({
      plan: execution, store,
      signer: { address: owner, describe: 'test', send: async () => hash },
      publicClient: { waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, transactionHash: `0x${'2'.repeat(64)}` }) },
      log: () => {},
    })).rejects.toThrow('replacement transaction')
    expect(store.load(execution.id)?.steps).toEqual([{ kind: 'submitted', hash }])
  })

  test('blocks new plans when a submission failed without a known hash', async () => {
    const store = memoryStore()
    const execution = plan()
    const signer = { address: owner, describe: 'test', send: async () => { throw new Error('connection lost') } }
    await expect(sendPlan({ plan: execution, store, signer, log: () => {} })).rejects.toThrow('unknown')
    await expect(sendPlan({ plan: plan(), store, signer, log: () => {} })).rejects.toThrow('unresolved')
    await expect(sendPlan({ plan: execution, store, signer, log: () => {} })).rejects.toThrow('unknown')
  })
})
