import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import * as Prompt from 'effect/unstable/cli/Prompt'
import { createFileJournalStore } from '../execution-journal'
import { sendPlan } from '../send'
import { loadAlmState } from '../alm/state'
import { fromPromise, resolveSigner } from './run-action'

const list = Command.make('list', {}, Effect.fn(function* () {
  const entries = createFileJournalStore().list().map(({ plan, status, steps }) => ({
    id: plan.id, chain: plan.chainId, sender: plan.sender, status, steps,
  }))
  yield* Console.log(JSON.stringify(entries, null, 2))
})).pipe(Command.withDescription('List persisted executions and known transaction hashes'))

const resume = Command.make('resume', { id: Flag.string('id') }, Effect.fn(function* ({ id }) {
  const store = createFileJournalStore()
  const entry = store.load(id)
  if (!entry) throw new Error('Execution not found')
  if (Object.values(loadAlmState()).some((state) => state.cycle?.phases.some((phase) => phase.executionId === id))) {
    throw new Error('ALM phases cannot be resumed independently; use aero alm recover and manually repair the cycle')
  }
  yield* Console.log(`Chain ${entry.plan.chainId}, sender ${entry.plan.sender}\n${JSON.stringify(entry.steps, null, 2)}`)
  if (!(yield* Prompt.confirm({ message: 'Reconcile receipts and continue unsubmitted steps of this reviewed plan?' }))) return
  const signer = yield* resolveSigner()
  const hashes = yield* fromPromise(() => sendPlan({ plan: entry.plan, signer, store }))
  yield* Console.log(JSON.stringify({ status: 'complete', hashes }))
})).pipe(Command.withDescription('Resume a saved plan without resending submitted transactions'))

const cancel = Command.make('cancel', { id: Flag.string('id') }, Effect.fn(function* ({ id }) {
  const store = createFileJournalStore()
  const entry = store.load(id)
  if (!entry) throw new Error('Execution not found')
  const release = store.acquire(entry.plan.chainId, entry.plan.sender)
  try {
    const current = store.load(id)
    if (!current || current.status !== 'active') throw new Error('Execution is not active')
    if (current.steps.some((step) => step.kind === 'submitted' || step.kind === 'submitting')) throw new Error('Cannot cancel an unknown or pending submission; reconcile it first')
    if (!(yield* Prompt.confirm({ message: 'Cancel the remaining unsubmitted steps? Confirmed transactions cannot be undone.' }))) return
    store.save({ ...current, status: 'cancelled' })
    yield* Console.log('Unsubmitted steps cancelled.')
  } finally {
    release()
  }
})).pipe(Command.withDescription('Cancel only steps that have not been submitted'))

export const executionCommand = Command.make('executions').pipe(
  Command.withDescription('Inspect, reconcile, and cancel persisted transaction plans'),
  Command.withSubcommands([list, resume, cancel]),
)
