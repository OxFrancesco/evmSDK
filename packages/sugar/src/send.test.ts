import { TransactionNotSubmittedError } from './submission-error'
import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { isHex, parseTransaction } from 'viem'
import { createExecutionPlan, localMnemonicSigner, renderPlanSummary, sendPlan, withGasMargin, type ExecutionJournal, type PlanJournalStore, type SendPlanOptions } from './send'

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

test('terminal review escapes token controls without altering trusted line boundaries', () => {
  const symbol = '正常\u001b[2J\r\nFAKE\u009b2K\u202e\u2028'
  const summary = renderPlanSummary('swap', {
    quote: { from_token: { symbol, address: '0x1111111111111111111111111111111111111111' }, to_token: { symbol: 'USDC', address: '0x2222222222222222222222222222222222222222' }, amount_in_decimal: 10, amount_out_decimal: 20, min_amount_out_decimal: 19, slippage: 0.01, price_impact_pct: null },
    allocation: [{ symbol, current_pct: '1\r99', target_pct: 50 }],
    trades: [{ amount: 1, from: symbol, expected: 2, to: 'USDC', minimum: 1 }],
  }, [])
  expect(summary).toContain('正常\\u001b[2J\\u000d\\u000aFAKE\\u009b2K\\u202e\\u2028')
  for (const code of [0x0d, 0x1b, 0x9b, 0x202e, 0x2028]) expect(summary).not.toContain(String.fromCharCode(code))
  expect(summary).toContain('\n  from asset: 0x1111111111111111111111111111111111111111\n')
})

test('definite wallet rejection leaves a persisted retryable step without resending confirmed steps', async () => {
  const store = memoryStore()
  const base = plan()
  const execution = createExecutionPlan({ ...base, steps: [{ ...base.steps[0], role: 'approval' }, base.steps[0]] })
  let calls = 0
  const options: SendPlanOptions = { plan: execution, store, log: () => {},
    signer: { address: owner, describe: 'test', send: async () => { if (++calls === 2) throw new TransactionNotSubmittedError('Rejected'); return hash } },
    publicClient: { waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, transactionHash: hash }) },
  }
  await expect(sendPlan(options)).rejects.toThrow('Rejected')
  expect(store.load(execution.id)?.steps).toEqual([{ kind: 'confirmed', hash }, { kind: 'ready' }])
  await expect(sendPlan(options)).resolves.toEqual([hash, hash])
  expect(calls).toBe(3)
})

describe('local signer gas margin', () => {
  type RpcCall = { id?: number | string | null; method?: string; params?: unknown }
  type FakeBlock = {
    number: string; hash: string; parentHash: string; nonce: string; sha3Uncles: string
    logsBloom: string; transactionsRoot: string; stateRoot: string; receiptsRoot: string
    miner: string; difficulty: string; totalDifficulty: string; extraData: string; size: string
    gasLimit: string; gasUsed: string; timestamp: string; baseFeePerGas: string
    mixHash: string; transactions: string[]; uncles: string[]
  }
  type FeeHistory = { oldestBlock: string; baseFeePerGas: string[]; gasUsedRatio: number[]; reward: string[][] }
  type FakeNodeReply = string | FakeBlock | FeeHistory

  const mnemonic = 'test test test test test test test test test test test junk'

  /** Fake JSON-RPC node; eth_estimateGas fails with `execution reverted` for the first `estimateFailures` calls. */
  function startFakeNode(estimateFailures = 0) {
    let rawTransaction: Hex | undefined
    let estimateCalls = 0
    let sendRawCalls = 0
    let failuresLeft = estimateFailures
    const missed: string[] = []
    const resultFor = (call: RpcCall): FakeNodeReply | undefined => {
      switch (call.method) {
        case 'eth_chainId': return '0x2105'
        case 'eth_getTransactionCount': return '0x0'
        // 245,643: the exact estimate the reverted swap signed without margin.
        case 'eth_estimateGas': return '0x3bf8b'
        case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
        case 'eth_gasPrice': return '0x77359400'
        case 'eth_getBlockByNumber': return {
          number: '0x1', hash: `0x${'a'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`,
          nonce: '0x0000000000000000', sha3Uncles: `0x${'0'.repeat(64)}`, logsBloom: `0x${'0'.repeat(512)}`,
          transactionsRoot: `0x${'0'.repeat(64)}`, stateRoot: `0x${'0'.repeat(64)}`, receiptsRoot: `0x${'0'.repeat(64)}`,
          miner: owner, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x100',
          gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x65f1a000', baseFeePerGas: '0x3b9aca00',
          mixHash: `0x${'0'.repeat(64)}`, transactions: [], uncles: [],
        }
        case 'eth_feeHistory': return { oldestBlock: '0x1', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }
        case 'eth_sendRawTransaction': {
          const params = Array.isArray(call.params) ? call.params : []
          rawTransaction = isHex(params[0]) ? params[0] : undefined
          return `0x${'3'.repeat(64)}`
        }
        default: {
          missed.push(String(call.method))
          return undefined
        }
      }
    }
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        // SAFETY: JSON-RPC bodies are an object or an array of objects; fields are read defensively.
        const body = await request.json() as RpcCall | RpcCall[]
        const calls = Array.isArray(body) ? body : [body]
        const replies = calls.map((call) => {
          if (call.method === 'eth_estimateGas') {
            estimateCalls++
            if (failuresLeft > 0) {
              failuresLeft--
              return { jsonrpc: '2.0', id: call.id ?? null, error: { code: 3, message: 'execution reverted' } }
            }
          }
          if (call.method === 'eth_sendRawTransaction') sendRawCalls++
          const result = resultFor(call)
          return result === undefined
            ? { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32601, message: `unstubbed method ${String(call.method)}` } }
            : { jsonrpc: '2.0', id: call.id ?? null, result }
        })
        return Response.json(Array.isArray(body) ? replies : replies[0])
      },
    })
    return {
      url: `http://127.0.0.1:${String(server.port)}`,
      missed,
      get rawTransaction() { return rawTransaction },
      get estimateCalls() { return estimateCalls },
      get sendRawCalls() { return sendRawCalls },
      stop: () => { server.stop(true) },
    }
  }

  test('adds 25% over the estimate and keeps zero at zero', () => {
    expect(withGasMargin(245_643n)).toBe(307_053n)
    expect(withGasMargin(0n)).toBe(0n)
    expect(withGasMargin(100n, 0n)).toBe(100n)
  })

  test('signs the estimate plus margin against a fake node', async () => {
    const node = startFakeNode()
    try {
      const signer = localMnemonicSigner(mnemonic, node.url)
      await signer.send({ from: signer.address, to: target, data: '0x', value: 0n }, 8453)
      expect(node.missed).toEqual([])
      if (node.rawTransaction === undefined) throw new Error('the node recorded no raw transaction')
      expect(parseTransaction(node.rawTransaction).gas).toBe(307_053n)
    } finally {
      node.stop()
    }
  })

  test('retries preparation through transient estimate failures', async () => {
    const node = startFakeNode(2)
    try {
      const signer = localMnemonicSigner(mnemonic, node.url, { prepareAttempts: 3, prepareBaseDelayMs: 1 })
      await signer.send({ from: signer.address, to: target, data: '0x', value: 0n }, 8453)
      expect(node.estimateCalls).toBe(3)
      if (node.rawTransaction === undefined) throw new Error('the node recorded no raw transaction')
      expect(parseTransaction(node.rawTransaction).gas).toBe(307_053n)
    } finally {
      node.stop()
    }
  })

  test('gives up after the preparation attempts and never broadcasts', async () => {
    const node = startFakeNode(3)
    try {
      const signer = localMnemonicSigner(mnemonic, node.url, { prepareAttempts: 3, prepareBaseDelayMs: 1 })
      const failure: unknown = await signer.send({ from: signer.address, to: target, data: '0x', value: 0n }, 8453).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(TransactionNotSubmittedError)
      const message = failure instanceof Error ? failure.message : String(failure)
      expect(message).toContain('after 3 attempts')
      expect(message).toContain('execution reverted')
      expect(node.estimateCalls).toBe(3)
      expect(node.sendRawCalls).toBe(0)
    } finally {
      node.stop()
    }
  })
})
