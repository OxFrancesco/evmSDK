import type { PublicClient } from 'viem'
import { normalizeAddress } from '../helpers'
import type { ExecutionJournal, PlanJournalStore } from '../send'
import type { AlmCycle, AlmPositionState } from './state'

export async function reconcileAlmCycle(
  cycle: AlmCycle,
  store: PlanJournalStore,
  client: Pick<PublicClient, 'getTransactionReceipt' | 'getChainId'>,
): Promise<ExecutionJournal[]> {
  if (await client.getChainId() !== cycle.chain) throw new Error('Recovery RPC chain differs from the ALM cycle')
  const journals: ExecutionJournal[] = []
  for (const phase of cycle.phases) {
    const journal = store.load(phase.executionId)
    if (!journal) throw new Error(`Missing execution journal ${phase.executionId}; inspect wallet activity before recovery`)
    if (journal.plan.chainId !== cycle.chain || journal.plan.sender !== normalizeAddress(cycle.wallet)) {
      throw new Error('ALM cycle and execution journal identities differ')
    }
    const release = store.acquire(journal.plan.chainId, journal.plan.sender)
    try {
      const current = store.load(phase.executionId)
      if (!current) throw new Error('Execution journal disappeared')
      for (const [index, step] of current.steps.entries()) {
        if (step.kind !== 'submitted') continue
        const receipt = await client.getTransactionReceipt({ hash: step.hash }).catch(() => undefined)
        if (!receipt || receipt.transactionHash.toLowerCase() !== step.hash.toLowerCase()) continue
        current.steps[index] = { kind: receipt.status === 'success' ? 'confirmed' : 'reverted', hash: step.hash }
      }
      if (current.steps.some((step) => step.kind === 'reverted')) current.status = 'failed'
      else if (current.steps.every((step) => step.kind === 'confirmed')) current.status = 'complete'
      store.save(current)
      journals.push(current)
    } finally {
      release()
    }
  }
  return journals
}

export function resolveAlmCycle(cycle: AlmCycle, journals: ExecutionJournal[], store: PlanJournalStore, note: string): AlmCycle {
  if (cycle.status.kind !== 'active') throw new Error('ALM cycle is not active')
  if (!note.trim()) throw new Error('A recovery note describing the manually verified outcome is required')
  if (journals.length !== cycle.phases.length || journals.some((entry, index) => entry.plan.id !== cycle.phases[index].executionId)) {
    throw new Error('Reconcile every ALM phase before resolving the cycle')
  }
  const release = store.acquire(cycle.chain, normalizeAddress(cycle.wallet))
  try {
    const current = journals.map((journal) => {
      const entry = store.load(journal.plan.id)
      if (!entry || entry.plan.chainId !== cycle.chain || entry.plan.sender !== normalizeAddress(cycle.wallet)) throw new Error('ALM journal missing or identity changed')
      return entry
    })
    for (const journal of current) {
      if (journal.steps.some((step) => step.kind === 'submitted' || step.kind === 'submitting')) {
        throw new Error('Cannot resolve an unknown or pending submission; inspect wallet activity and reconcile first')
      }
    }
    for (const journal of current) {
      if (journal.status === 'active') store.save({ ...journal, status: 'cancelled' })
    }
    return { ...cycle, status: { kind: 'resolved', note: note.trim() } }
  } finally {
    release()
  }
}

export function recoveredPositionState(entry: AlmPositionState, cycle: AlmCycle, positionId: bigint): AlmPositionState {
  if (cycle.status.kind !== 'resolved') throw new Error('Resolve the ALM cycle before updating its position')
  if (positionId <= 0n) throw new Error('Recovery needs a positive NFT id')
  return { ...entry, managedPositionId: positionId.toString(), cycle: { ...cycle, resultPositionId: positionId.toString() } }
}
