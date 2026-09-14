import * as Command from 'effect/unstable/cli/Command'
import type * as Flag from 'effect/unstable/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import { ACTION_SCHEMA, acceptsWallet, type ActionSpec } from '../action-schema'
import { isSugarTxAction, type SugarAction, type SugarParameters } from '../contracts'
import * as flags from './flags'
import { runReadAction, runTxAction } from './run-action'

/** Parsed flags keyed by parameter name; optional flags arrive as `Option`. */
type ParsedFlags = Record<string, flags.FlagValue>

/** `--chain` first, `--wallet` where the action reads one, then the action's own flags. */
function contextFlags(action: SugarAction): Record<string, Flag.Flag<flags.FlagValue>> {
  const config = flags.flagsFor([])
  config.chain = flags.chain
  if (acceptsWallet(action)) config.wallet = flags.wallet
  return config
}

/**
 * One `aero <action>` subcommand per schema entry. Flags, help text, and
 * examples all come from `ACTION_SCHEMA`; this file only decides which
 * context flags an action gets and which runner handles it.
 */
export function actionCommand(action: SugarAction, name = action.replaceAll('_', '-')) {
  const spec: ActionSpec = ACTION_SCHEMA[action]
  const config = Object.assign(contextFlags(action), flags.flagsFor(spec.parameters))
  if (isSugarTxAction(action)) {
    config.yes = flags.yes
    config.dryRun = flags.dryRun
  }
  const command = Command.make(name, config, Effect.fn(function* (parsed) {
    const values: ParsedFlags = parsed
    const parameters: SugarParameters = { chain: Number(values.chain), ...flags.parametersFrom(spec.parameters, values) }
    const wallet = Option.isOption(values.wallet) ? Option.getOrUndefined(values.wallet) : undefined
    if (Predicate.isString(wallet)) parameters.wallet = wallet
    if (isSugarTxAction(action)) {
      yield* runTxAction(action, parameters, { yes: values.yes === true, dryRun: values.dryRun === true })
    } else {
      yield* runReadAction(action, parameters)
    }
  })).pipe(Command.withDescription(spec.description))
  return spec.examples ? command.pipe(Command.withExamples([...spec.examples])) : command
}

/** Top-level Aerodrome commands, in the order a newcomer meets them. */
const TOP_LEVEL_ACTIONS: readonly SugarAction[] = [
  'quote',
  'swap',
  'pools',
  'deposit',
  'withdraw',
  'positions',
  'stake',
  'unstake',
  'claim_emissions',
  'claim_fees',
  'create_venft',
  'epochs_latest',
  'epochs',
]

export const actionCommands = TOP_LEVEL_ACTIONS.map((action) => actionCommand(action))
