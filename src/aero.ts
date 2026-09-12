import { Effect, Schema } from 'effect'
import { executeSugarActionJson, isSugarAction, SUGAR_ACTIONS } from '@beegreat/sugar'
import { Address, ChainId, EvmError, Hex, Id, Uint } from './model'
import { createWorkflow } from './workflows'
import { Network } from './network'

export const AeroInput = Schema.Struct({ action: Schema.String, parameters: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])), key: Schema.optionalKey(Id), policy: Schema.optionalKey(Id) })
const Transactions = Schema.Struct({ transactions: Schema.Array(Schema.Struct({ from: Address, to: Address, data: Hex, value: Uint })) })
export const aero = Effect.fn('Aero.action')(function* (input: Schema.Schema.Type<typeof AeroInput>) {
  if (!isSugarAction(input.action)) return yield* new EvmError({ code: 'InvalidInput', message: `Supported Aero actions: ${SUGAR_ACTIONS.join(', ')}`, retryable: false })
  const action = input.action
  const chainId = yield* Schema.decodeUnknownEffect(ChainId)(input.parameters.chain).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'Aero parameters require chain.', retryable: false })))
  const network = yield* Network
  yield* network.client(chainId)
  const rpcUrl = network.options.rpcUrls?.get(chainId) ?? network.options.rpcUrl
  const text = yield* Effect.tryPromise({ try: () => executeSugarActionJson(action, input.parameters, { rpcUrl }), catch: error => new EvmError({ code: 'ProviderUnavailable', message: error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[provider]') : 'Aero action failed.', retryable: false }) })
  const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidState', message: 'Aero returned invalid JSON.', retryable: false })))
  const transactions = Schema.decodeUnknownOption(Transactions)(result)
  if (transactions._tag === 'None') return { result, workflow: null }
  if (!input.key) return { result, workflow: null }
  const workflow = yield* createWorkflow({ key: input.key, steps: transactions.value.transactions.map((tx, index) => ({ label: `Aero ${action} ${index + 1}`, intent: { chainId, account: tx.from, to: tx.to, data: tx.data, value: tx.value, key: input.key ?? '', policy: input.policy } })) })
  return { result, workflow }
})
