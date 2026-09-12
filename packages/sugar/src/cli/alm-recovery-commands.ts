import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import * as Prompt from 'effect/unstable/cli/Prompt'
import { createPublicClient, http } from 'viem'
import { reconcileAlmCycle, recoveredPositionState, resolveAlmCycle } from '../alm/recovery'
import { acquireAlmStateLock, loadAlmState, saveAlmState } from '../alm/state'
import { SugarClient } from '../client'
import { normalizeAddress } from '../helpers'
import { optionalValue } from './flags'
import { createFileJournalStore } from '../execution-journal'
import { chainForSettings } from '../send'
import { fromPromise } from './run-action'

function recoveryContext(id: string) {
  const state = loadAlmState()
  const match = Object.entries(state).find(([, entry]) => entry.cycle?.id === id)
  if (!match || !match[1].cycle) throw new Error('ALM cycle not found; run aero alm status')
  const [key, entry] = match
  const cycle = match[1].cycle
  const store = createFileJournalStore()
  const client = createPublicClient({ chain: chainForSettings(cycle.chain), transport: http() })
  return { state, key, entry, cycle, store, client }
}

export const almRecoverCommand = Command.make('recover', { id: Flag.string('id') }, Effect.fn(function* ({ id }) {
  const release = acquireAlmStateLock()
  try {
    const { cycle, store, client } = recoveryContext(id)
    const journals = yield* fromPromise(() => reconcileAlmCycle(cycle, store, client))
    yield* Console.log(JSON.stringify({ cycle, executions: journals.map(({ plan, status, steps }) => ({ id: plan.id, status, steps })) }, null, 2))
    yield* Console.log('Receipts checked without signing. Repair any partial position manually, then use aero alm resolve --id <id> --note <verified outcome>. Unknown submissions must be reconciled first.')
  } finally {
    release()
  }
})).pipe(Command.withDescription('Reconcile ALM receipts without submitting or restarting any phase'))

export const almResolveCommand = Command.make('resolve', {
  id: Flag.string('id'),
  note: Flag.string('note'),
  positionId: Flag.string('position-id').pipe(Flag.optional, Flag.withDescription('NFT to track after manual repair, defaults to the recorded replacement or original NFT')),
}, Effect.fn(function* ({ id, note, positionId }) {
  const release = acquireAlmStateLock()
  try {
    const { state, key, entry, cycle, store, client } = recoveryContext(id)
    const journals = yield* fromPromise(() => reconcileAlmCycle(cycle, store, client))
    yield* Console.log(JSON.stringify({ cycle, steps: journals.map((journal) => journal.steps) }, null, 2))
    const selectedId = optionalValue(positionId) ?? cycle.resultPositionId ?? cycle.positionId
    if (!/^[1-9]\d*$/.test(selectedId)) throw new Error('position-id must be a positive NFT id')
    const sugar = new SugarClient(cycle.chain, { account: normalizeAddress(cycle.wallet) })
    const position = yield* fromPromise(() => sugar.getPositionById(BigInt(selectedId), normalizeAddress(cycle.wallet), normalizeAddress(cycle.pool)))
    if (!position || !position.pool.isCl || position.isAlm || (position.liquidity === 0n && position.staked === 0n)) {
      throw new Error('Recovery needs an owned, funded CL NFT; rebuild the position and pass --position-id')
    }
    yield* Console.log(`Future ALM cycles will track NFT ${selectedId} in pool ${cycle.pool}`)
    if (!(yield* Prompt.confirm({ message: 'Have you verified the receipts, balances, NFT ownership and staking, and manually repaired this cycle? Resolving permits future ALM cycles.' }))) return
    const resolved = resolveAlmCycle(cycle, journals, store, note)
    saveAlmState({ ...state, [key]: recoveredPositionState(entry, resolved, position.id) })
    yield* Console.log('Cycle resolved. Unsubmitted steps were cancelled. Attempt cooldowns and caps remain in effect; run aero serve --once in dry-run mode before restarting execution.')
  } finally {
    release()
  }
})).pipe(Command.withDescription('Acknowledge manual ALM recovery without replaying any transactions'))
