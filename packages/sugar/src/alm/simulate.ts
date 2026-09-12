import type { Address, PublicClient } from 'viem'
import type { PlanStep } from '../send'

/**
 * Pre-flight simulation of a transaction plan via `eth_simulateV1`
 * (viem `simulateCalls`). The whole phase (approvals + action) is simulated
 * as one block, so an approval that enables the action is respected. A plan
 * is only signed after every step simulates successfully.
 */

export type PlanSimulation =
  | { outcome: 'ok'; gasUsed: bigint }
  | { outcome: 'revert'; step: number; role: PlanStep['role']; reason: string }
  | { outcome: 'unsupported'; reason: string }

export async function simulatePlan(client: PublicClient, account: Address, steps: PlanStep[]): Promise<PlanSimulation> {
  let results: Array<{ status: string; error?: { message?: string }; gasUsed: bigint }>
  try {
    const simulated = await client.simulateCalls({
      account,
      calls: steps.map((step) => ({ to: step.transaction.to, data: step.transaction.data, value: step.transaction.value })),
    })
    // SAFETY: viem's simulateCalls result items always carry status, gasUsed,
    // and an optional error; only those fields are read below.
    results = simulated.results as typeof results
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/method|support|not found|not available|unknown/i.test(message)) {
      return { outcome: 'unsupported', reason: `RPC does not support eth_simulateV1: ${message.split('\n')[0]}` }
    }
    return { outcome: 'revert', step: 0, role: steps[0]?.role ?? 'action', reason: message.split('\n')[0] }
  }
  if (results.length !== steps.length) return { outcome: 'revert', step: 0, role: steps[0]?.role ?? 'action', reason: 'RPC returned an incomplete simulation' }
  for (const [index, result] of results.entries()) {
    if (result.status !== 'success') {
      return {
        outcome: 'revert',
        step: index,
        role: steps[index]?.role ?? 'action',
        reason: result.error?.message?.split('\n')[0] ?? 'execution reverted',
      }
    }
  }
  return { outcome: 'ok', gasUsed: results.reduce((sum, result) => sum + result.gasUsed, 0n) }
}
