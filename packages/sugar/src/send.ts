import { TransactionNotSubmittedError } from './submission-error'
import * as Predicate from 'effect/Predicate'
import type { Address, Hex, TransactionReceipt } from 'viem'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { getChainSettings, isSupportedChainId } from './config'
import { normalizeAddress } from './helpers'
import { createFileJournalStore } from './execution-journal'
import { parseMnemonic } from './wallet'
import type { SugarTxAction } from './contracts'
import type { SugarJson, UnsignedTransaction } from './types'

/**
 * Signing and broadcasting for the CLI's wallet-connected flow. Plans still
 * come from the non-signing Sugar action layer; this module only turns an
 * already-printed plan into sequential on-chain transactions.
 */

export type PlanStep = { role: 'approval' | 'action'; transaction: UnsignedTransaction }

export type PlanSigner = {
  address: Address
  describe: string
  send: (transaction: UnsignedTransaction, chainId: number) => Promise<Hex>
}

function asRecord(value: SugarJson): Record<string, SugarJson> {
  if (value === null || !Predicate.isObject(value) || Array.isArray(value)) {
    throw new Error('unexpected Sugar plan shape')
  }
  return value
}

/** Rehydrate the JSON plan (bigints were stringified by toSugarJson). */
export function extractPlanSteps(result: SugarJson): PlanStep[] {
  const record = asRecord(result)
  const steps = record.transaction_steps
  if (!Array.isArray(steps)) throw new Error('this action did not produce a transaction plan')
  return steps.map((step) => {
    const item = asRecord(step)
    const transaction = asRecord(item.transaction)
    const role = item.role === 'approval' ? 'approval' as const : 'action' as const
    // SAFETY: the plan was produced by toSugarJson from UnsignedTransaction
    // records, so from/to are 0x addresses and data is 0x calldata.
    return {
      role,
      transaction: {
        from: String(transaction.from) as Address,
        to: String(transaction.to) as Address,
        data: String(transaction.data) as Hex,
        value: BigInt(String(transaction.value ?? '0')),
      },
    }
  })
}

export function terminalScalar(value: SugarJson | undefined): string {
  return Array.from(String(value), character => {
    const code = character.charCodeAt(0)
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c || code === 0x200e || code === 0x200f || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    return control ? `\\u${code.toString(16).padStart(4, '0')}` : character
  }).join('')
}

const summaryLine = (label: string, value: SugarJson | undefined): string[] =>
  value === undefined || value === null ? [] : [`  ${label}: ${terminalScalar(Predicate.isObject(value) ? JSON.stringify(value) : value)}`]

/** Human summary shown before the confirm prompt. */
export function renderPlanSummary(action: SugarTxAction, result: SugarJson, steps: PlanStep[]): string {
  const record = asRecord(result)
  const lines: string[] = [`Plan: ${action.replaceAll('_', '-')} (${steps.length} transaction${steps.length === 1 ? '' : 's'}${steps.length > 1 ? ', approvals first' : ''})`]
  if (action === 'index_rebalance') lines.push(...summaryLine('Portfolio value in USDC', record.total_usdc), ...summaryLine('Add USDC', record.cash_contribution))
  if (Array.isArray(record.allocation) && record.allocation.length > 0) {
    lines.push('  Stock        Current       Target')
    for (const item of record.allocation) {
      const row = asRecord(item)
      lines.push(`  ${terminalScalar(row.symbol).padEnd(12)} ${terminalScalar(row.current_pct).padStart(6)}% -> ${terminalScalar(row.target_pct)}%`)
    }
  }
  if (Array.isArray(record.trades)) {
    for (const item of record.trades) {
      const trade = asRecord(item)
      lines.push(`  ${terminalScalar(trade.amount)} ${terminalScalar(trade.from)} -> ${terminalScalar(trade.expected)} ${terminalScalar(trade.to)}, minimum ${terminalScalar(trade.minimum)}`)
    }
    if (record.trades.length === 0) lines.push('  Already balanced. No transactions needed.')
    else lines.push('  All trades execute together. A failed trade reverts the basket.')
  }
  if (action === 'swap' && record.quote) {
    const quote = asRecord(record.quote)
    const from = asRecord(quote.from_token)
    const to = asRecord(quote.to_token)
    lines.push(
      ...summaryLine('swap', `${quote.amount_in_decimal} ${from.symbol} -> ${quote.amount_out_decimal} ${to.symbol}`),
      ...summaryLine('from asset', from.address),
      ...summaryLine('to asset', to.address),
      ...summaryLine('min out', `${quote.min_amount_out_decimal} ${to.symbol} (slippage ${quote.slippage})`),
      ...summaryLine('price impact', quote.price_impact_pct === null ? undefined : `${Number(quote.price_impact_pct).toFixed(3)}%`),
    )
  }
  if (action === 'deposit' && record.deposit) {
    const deposit = asRecord(record.deposit)
    const pool = asRecord(deposit.pool)
    lines.push(
      ...summaryLine('pool', pool.symbol),
      ...summaryLine('token0 asset', pool.token0_address),
      ...summaryLine('token1 asset', pool.token1_address),
      ...summaryLine('amount0', `${deposit.amount0_decimal} ${pool.token0}`),
      ...summaryLine('amount1', `${deposit.amount1_decimal} ${pool.token1}`),
      ...summaryLine('creates pool', deposit.creates_pool === true ? 'yes' : undefined),
    )
  }
  if (action === 'withdraw' && record.withdrawal) {
    const withdrawal = asRecord(record.withdrawal)
    const pool = asRecord(withdrawal.pool)
    lines.push(
      ...summaryLine('pool', pool.symbol),
      ...summaryLine('token0 asset', pool.token0_address),
      ...summaryLine('token1 asset', pool.token1_address),
      ...summaryLine('amount0', `${withdrawal.amount0_decimal} ${pool.token0}`),
      ...summaryLine('amount1', `${withdrawal.amount1_decimal} ${pool.token1}`),
      ...summaryLine('burn', withdrawal.burn === true ? 'yes' : undefined),
    )
  }
  if (action === 'create_venft' && record.ve_nft) {
    const venft = asRecord(record.ve_nft)
    lines.push(
      ...summaryLine('lock', `${venft.amount_decimal} ${venft.governance_symbol}`),
      ...summaryLine('duration', `${venft.lock_duration_seconds}s`),
    )
  }
  if (record.position) {
    const position = asRecord(record.position)
    const pool = position.pool === undefined ? undefined : asRecord(position.pool)
    lines.push(
      ...summaryLine('position', position.id),
      ...summaryLine('pool', pool?.symbol),
    )
  }
  return lines.join('\n')
}

export function chainForSettings(chainId: number, rpcUrl?: string) {
  const settings = getChainSettings(chainId, { overrides: rpcUrl ? { rpcUrl } : undefined })
  return defineChain({
    id: settings.chainId,
    name: settings.chainName,
    nativeCurrency: { name: settings.nativeTokenSymbol, symbol: settings.nativeTokenSymbol, decimals: settings.nativeTokenDecimals },
    rpcUrls: { default: { http: [settings.rpcUrl] } },
  })
}

export function localMnemonicSigner(mnemonic: string, rpcUrl?: string): PlanSigner {
  const account = mnemonicToAccount(parseMnemonic(mnemonic))
  return {
    address: account.address,
    describe: 'local wallet',
    send: async (transaction, chainId) => {
      let client: ReturnType<typeof createWalletClient>
      let signed: Hex
      try {
        const chain = chainForSettings(chainId, rpcUrl)
        client = createWalletClient({ account, chain, transport: http() })
        const request = await client.prepareTransactionRequest({ account, chain, to: transaction.to, data: transaction.data, value: transaction.value })
        signed = await client.signTransaction({ ...request, account })
      } catch (cause) {
        throw new TransactionNotSubmittedError('Local transaction preparation failed before broadcast', { cause })
      }
      return client.sendRawTransaction({ serializedTransaction: signed })
    },
  }
}

export type ExecutionPlan = Readonly<{
  id: string
  chainId: number
  sender: Address
  createdAt: number
  expiresAt: number
  steps: readonly Readonly<{ role: PlanStep['role']; transaction: Readonly<UnsignedTransaction> }>[]
}>

export type ExecutionStepState =
  | { kind: 'ready' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; hash: Hex }
  | { kind: 'confirmed'; hash: Hex }
  | { kind: 'reverted'; hash: Hex }

export type ExecutionJournal = {
  plan: ExecutionPlan
  status: 'active' | 'complete' | 'failed' | 'cancelled'
  steps: ExecutionStepState[]
}

export type PlanJournalStore = {
  load(id: string): ExecutionJournal | undefined
  save(journal: ExecutionJournal): void
  list(): ExecutionJournal[]
  acquire(chainId: number, sender: Address): () => void
}

export function createExecutionPlan(input: {
  steps: readonly PlanStep[]
  chainId: number
  sender: Address
  createdAt?: number
  expiresAt?: number
  id?: string
}): ExecutionPlan {
  if (!isSupportedChainId(input.chainId)) throw new Error('Unsupported execution chain')
  const sender = normalizeAddress(input.sender)
  const createdAt = input.createdAt ?? Date.now()
  const expiresAt = input.expiresAt ?? createdAt + 10 * 60_000
  if (![createdAt, expiresAt].every(Number.isSafeInteger) || expiresAt <= 0) throw new Error('Invalid plan timestamps')
  const id = input.id ?? crypto.randomUUID()
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid execution id')
  const steps = input.steps.map(({ role, transaction }) => {
    if (role !== 'approval' && role !== 'action') throw new Error('Invalid transaction role')
    if (normalizeAddress(transaction.from) !== sender) throw new Error('Transaction sender differs from plan sender')
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(transaction.data) || transaction.value < 0n) throw new Error('Invalid transaction calldata or value')
    return Object.freeze({ role, transaction: Object.freeze({ from: sender, to: normalizeAddress(transaction.to), data: transaction.data, value: transaction.value }) })
  })
  return Object.freeze({ id, chainId: input.chainId, sender, createdAt, expiresAt, steps: Object.freeze(steps) })
}

export function executionPlanToJson(plan: ExecutionPlan) {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step, transaction: { ...step.transaction, value: step.transaction.value.toString() } })) }
}

export type SendPlanOptions = {
  plan: ExecutionPlan
  signer: PlanSigner
  store?: PlanJournalStore
  rpcUrl?: string
  log?: (line: string) => void
  publicClient?: { waitForTransactionReceipt: (input: { hash: Hex }) => Promise<Pick<TransactionReceipt, 'status' | 'blockNumber' | 'transactionHash'>> }
  beforeSend?: () => Promise<void>
}

export async function sendPlan(options: SendPlanOptions): Promise<Hex[]> {
  const { plan, signer, rpcUrl, log = console.log } = options
  if (normalizeAddress(signer.address) !== plan.sender) throw new Error('Signing wallet differs from plan sender')
  const store = options.store ?? createFileJournalStore()
  const existing = store.load(plan.id)
  if (!existing && Date.now() >= plan.expiresAt) throw new Error('Plan expired; build and review a new plan')
  const release = store.acquire(plan.chainId, plan.sender)
  try {
    const journal = store.load(plan.id) ?? { plan, status: 'active' as const, steps: plan.steps.map((): ExecutionStepState => ({ kind: 'ready' })) }
    const serialize = (value: ExecutionPlan) => JSON.stringify(executionPlanToJson(value))
    if (serialize(journal.plan) !== serialize(plan)) throw new Error('Stored execution does not match the reviewed plan')
    if (journal.status === 'cancelled' || journal.status === 'failed') throw new Error(`Execution ${journal.status}; build a new plan after reviewing its receipts`)
    if (store.list().some((entry) => entry.plan.id !== plan.id && entry.status === 'active' && entry.plan.chainId === plan.chainId && entry.plan.sender === plan.sender)) {
      throw new Error('Wallet has an unresolved execution; inspect and resume it before starting another plan')
    }
    const publicClient = options.publicClient
      ?? createPublicClient({ chain: chainForSettings(plan.chainId, rpcUrl), transport: http() })
    const hashes: Hex[] = []
    store.save(journal)
    for (const [index, step] of plan.steps.entries()) {
      const label = `[${index + 1}/${plan.steps.length}] ${step.role}`
      let state = journal.steps[index]
      if (state.kind === 'confirmed') { hashes.push(state.hash); continue }
      if (state.kind === 'submitting') throw new Error(`Execution outcome unknown for step ${index + 1}; inspect the wallet activity before recovery`)
      if (state.kind === 'reverted') throw new Error(`Transaction reverted: ${state.hash}`)
      if (state.kind === 'ready') {
        if (Date.now() >= plan.expiresAt) throw new Error('Plan expired; cancel unsubmitted steps and build a new plan')
        await options.beforeSend?.()
        if (Date.now() >= plan.expiresAt) throw new Error('Plan expired before submission')
        journal.steps[index] = { kind: 'submitting' }
        store.save(journal)
        log(`${label}: sending via ${signer.describe}...`)
        let hash: Hex
        try {
          hash = await signer.send(step.transaction, plan.chainId)
          if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Wallet returned an invalid transaction hash')
        } catch (cause) {
          if (cause instanceof TransactionNotSubmittedError) {
            journal.steps[index] = { kind: 'ready' }
            store.save(journal)
            throw cause
          }
          throw new Error('Submission outcome unknown; this execution is blocked until reconciled', { cause })
        }
        state = { kind: 'submitted', hash }
        journal.steps[index] = state
        store.save(journal)
      }
      const hash = state.hash
      log(`${label}: ${hash} (waiting for confirmation)`)
      let receipt
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } catch (cause) {
        throw new Error(`Execution outcome unknown; resume ${plan.id} to check ${hash} without resending`, { cause })
      }
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Receipt belongs to a replacement transaction; review the replacement before recovery')
      journal.steps[index] = { kind: receipt.status === 'success' ? 'confirmed' : 'reverted', hash }
      if (receipt.status !== 'success') journal.status = 'failed'
      store.save(journal)
      if (receipt.status !== 'success') throw new Error(`${label} reverted on-chain: ${hash}`)
      hashes.push(hash)
      log(`${label}: confirmed in block ${receipt.blockNumber}`)
    }
    journal.status = 'complete'
    store.save(journal)
    return hashes
  } finally {
    release()
  }
}
