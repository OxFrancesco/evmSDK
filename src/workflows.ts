import { Clock, Effect, Schema } from 'effect'
import { keccak256, stringToHex, stringify } from 'viem'
import { readContract } from './contracts'
import { execute, prepare, status, waitForOperation } from './execution'
import { CallInput, EvmError, ExecuteInput, Id, PrepareInput, Hash } from './model'
import { Store } from './storage'

export const Condition = Schema.Struct({ call: CallInput, comparison: Schema.Literals(['equal', 'atLeast']), expected: Schema.Json })
export const WorkflowInput = Schema.Struct({ key: Id, steps: Schema.Array(Schema.Struct({ label: Schema.String, intent: PrepareInput, check: Schema.optionalKey(Condition) })).check(Schema.isMinLength(1), Schema.isMaxLength(32)) })
export interface WorkflowInput extends Schema.Schema.Type<typeof WorkflowInput> {}
export const Workflow = Schema.Struct({ ...WorkflowInput.fields, id: Id, fingerprint: Hash, createdAt: Schema.Number, cancelled: Schema.Boolean })
export interface Workflow extends Schema.Schema.Type<typeof Workflow> {}
export const WorkflowResult = Schema.Struct({ workflow: Workflow, state: Schema.Literals(['prepared', 'pending', 'completed', 'reverted', 'cancelled']), completedSteps: Schema.Number, operationIds: Schema.Array(Id) })

export const createWorkflow = Effect.fn('Workflow.create')(function* (input: WorkflowInput) {
  const id = keccak256(stringToHex(`workflow:${input.key}`))
  const fingerprint = keccak256(stringToHex(JSON.stringify(input)))
  const createdAt = yield* Clock.currentTimeMillis
  const document = yield* (yield* Store).updateDocument(`workflow:${id}`, value => {
    if (value !== null) {
      const prior = Schema.decodeUnknownSync(Workflow)(value)
      if (prior.fingerprint !== fingerprint) throw new EvmError({ code: 'IdempotencyConflict', message: 'Workflow key belongs to different steps.', retryable: false })
      return prior
    }
    return { ...input, id, fingerprint, createdAt, cancelled: false }
  })
  return Schema.decodeUnknownSync(Workflow)(document)
})
export const getWorkflow = Effect.fn('Workflow.get')(function* (id: string) {
  return yield* Schema.decodeUnknownEffect(Workflow)(yield* (yield* Store).document(`workflow:${id}`)).pipe(Effect.mapError(() => new EvmError({ code: 'NotFound', message: 'Workflow does not exist or is corrupt.', retryable: false })))
})
export const verifyCondition = Effect.fn('Workflow.verifyOutcome')(function* (condition: Schema.Schema.Type<typeof Condition>) {
  const actual = yield* readContract(condition.call)
  const actualJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(actual.value))
  const matches = condition.comparison === 'equal' ? JSON.stringify(actualJson) === JSON.stringify(condition.expected) : (() => {
    const a = Schema.decodeUnknownOption(Schema.String.check(Schema.isPattern(/^\d+$/)))(String(actualJson))
    const b = Schema.decodeUnknownOption(Schema.String.check(Schema.isPattern(/^\d+$/)))(condition.expected)
    return a._tag === 'Some' && b._tag === 'Some' && BigInt(a.value) >= BigInt(b.value)
  })()
  if (!matches) return yield* new EvmError({ code: 'OutcomeMismatch', message: 'Transaction was included but the requested contract outcome was not observed. Workflow stopped.', retryable: false })
  return actual
})
export const runWorkflow = Effect.fn('Workflow.run')(function* (input: Schema.Schema.Type<typeof ExecuteInput>) {
  const workflow = yield* getWorkflow(input.id)
  if (workflow.cancelled) return { workflow, state: 'cancelled' as const, completedSteps: 0, operationIds: [] }
  if (input.approval._tag === 'required' || input.approval._tag === 'approved' && input.approval.fingerprint !== workflow.fingerprint) return yield* new EvmError({ code: 'ApprovalRequired', message: `Approve workflow fingerprint ${workflow.fingerprint} or use --yolo.`, retryable: false })
  const operationIds: string[] = []
  let completedSteps = 0
  for (const [index, step] of workflow.steps.entries()) {
    if ((yield* getWorkflow(input.id)).cancelled) return { workflow, state: 'cancelled' as const, completedSteps, operationIds }
    const operation = yield* prepare({ ...step.intent, key: keccak256(stringToHex(`${workflow.id}:${index}`)) })
    operationIds.push(operation.plan.id)
    const sent = yield* execute({ id: operation.plan.id, approval: { _tag: 'approved', fingerprint: operation.plan.fingerprint } })
    const checked = ['pending', 'submitting', 'walletPending'].includes(sent.state._tag) ? yield* waitForOperation(operation.plan.id) : sent
    if (checked.state._tag === 'reverted') return { workflow, state: 'reverted' as const, completedSteps, operationIds }
    if (checked.state._tag !== 'confirmed') return { workflow, state: 'pending' as const, completedSteps, operationIds }
    if (step.check) {
      const store = yield* Store
      const key = `workflow-check:${workflow.id}:${index}`
      const prior = yield* store.document(key)
      const evidence = { hash: checked.state.hash, blockHash: checked.state.blockHash ?? null }
      if (JSON.stringify(prior) !== JSON.stringify(evidence)) { yield* verifyCondition(step.check); yield* store.putDocument(key, evidence) }
    }
    completedSteps++
  }
  return { workflow, state: 'completed' as const, completedSteps, operationIds }
})
export const workflowStatus = Effect.fn('Workflow.status')(function* (id: string) {
  const workflow = yield* getWorkflow(id)
  const operationIds: string[] = []
  let completedSteps = 0
  for (const [index, step] of workflow.steps.entries()) {
    const key = keccak256(stringToHex(`${workflow.id}:${index}`))
    const op = yield* status(keccak256(stringToHex(key))).pipe(Effect.catchIf(e => e.code === 'NotFound', () => Effect.succeed(null)))
    if (!op) break
    operationIds.push(op.plan.id)
    if (op.state._tag === 'confirmed') {
      const evidence = step.check ? yield* (yield* Store).document(`workflow-check:${workflow.id}:${index}`) : null
      if (step.check && JSON.stringify(evidence) !== JSON.stringify({ hash: op.state.hash, blockHash: op.state.blockHash ?? null })) break
      completedSteps++
    }
    if (op.state._tag === 'reverted') return { workflow, state: 'reverted' as const, completedSteps, operationIds }
  }
  return { workflow, state: workflow.cancelled ? 'cancelled' as const : completedSteps === workflow.steps.length ? 'completed' as const : operationIds.length ? 'pending' as const : 'prepared' as const, completedSteps, operationIds }
})
export const cancelWorkflow = Effect.fn('Workflow.cancel')(function* (id: string) {
  const workflow = yield* getWorkflow(id)
  yield* (yield* Store).putDocument(`workflow:${id}`, { ...workflow, cancelled: true })
  return yield* workflowStatus(id)
})
