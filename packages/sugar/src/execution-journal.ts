import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Schema from 'effect/Schema'
import { flow } from 'effect/Function'
import { isHex } from 'viem'
import { normalizeAddress } from './helpers'
import { createExecutionPlan, executionPlanToJson, type ExecutionJournal, type ExecutionStepState, type PlanJournalStore } from './send'
import { walletDir } from './wallet'

const StepSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(['ready', 'submitting']) }),
  Schema.Struct({ kind: Schema.Literals(['submitted', 'confirmed', 'reverted']), hash: Schema.String }),
])
const JournalSchema = Schema.Struct({
  status: Schema.Literals(['active', 'complete', 'failed', 'cancelled']),
  plan: Schema.Struct({
    id: Schema.String,
    chainId: Schema.Int,
    sender: Schema.String,
    createdAt: Schema.Int,
    expiresAt: Schema.Int,
    steps: Schema.Array(Schema.Struct({
      role: Schema.Literals(['approval', 'action']),
      transaction: Schema.Struct({ from: Schema.String, to: Schema.String, data: Schema.String, value: Schema.String }),
    })),
  }),
  steps: Schema.Array(StepSchema),
})

function rehydrateExecutionJournal(wire: typeof JournalSchema.Type): ExecutionJournal {
  const plan = createExecutionPlan({
    ...wire.plan,
    sender: normalizeAddress(wire.plan.sender),
    steps: wire.plan.steps.map(({ role, transaction }) => {
      if (!isHex(transaction.data)) throw new Error('Invalid journal calldata')
      return { role, transaction: { ...transaction, from: normalizeAddress(transaction.from), to: normalizeAddress(transaction.to), data: transaction.data, value: BigInt(transaction.value) } }
    }),
  })
  const steps = wire.steps.map((state): ExecutionStepState => {
    if (!('hash' in state)) return state
    if (!isHex(state.hash) || state.hash.length !== 66) throw new Error('Invalid journal transaction hash')
    return { ...state, hash: state.hash }
  })
  if (steps.length !== plan.steps.length) throw new Error('Execution journal step count mismatch')
  if (wire.status === 'complete' && steps.some((step) => step.kind !== 'confirmed')) throw new Error('Incomplete journal marked complete')
  return { status: wire.status, plan, steps }
}

export const decodeExecutionJournal = flow(Schema.decodeUnknownSync(JournalSchema), rehydrateExecutionJournal)

export function createFileJournalStore(directory = join(walletDir(), 'executions')): PlanJournalStore {
  const pathFor = (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid execution id')
    return join(directory, `${id}.json`)
  }
  const load = (id: string): ExecutionJournal | undefined => {
    const path = pathFor(id)
    if (!existsSync(path)) return undefined
    return decodeExecutionJournal(JSON.parse(readFileSync(path, 'utf8')))
  }
  return {
    load,
    list: () => !existsSync(directory) ? [] : readdirSync(directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((name) => load(name.slice(0, -5)))
      .filter((entry): entry is ExecutionJournal => entry !== undefined),
    save: (journal) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const destination = pathFor(journal.plan.id)
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ ...journal, plan: executionPlanToJson(journal.plan) }))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, destination)
      const directoryFd = openSync(directory, 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    },
    acquire: (chainId, sender) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${chainId}-${normalizeAddress(sender)}.lock`)
      let fd: number
      try {
        fd = openSync(path, 'wx', 0o600)
      } catch (cause) {
        throw new Error(`Execution is locked. Stop overlapping Aero processes and inspect ${path} before recovery`, { cause })
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
        fsyncSync(fd)
      } catch (cause) {
        closeSync(fd)
        unlinkSync(path)
        throw cause
      }
      return () => { closeSync(fd); unlinkSync(path) }
    },
  }
}
