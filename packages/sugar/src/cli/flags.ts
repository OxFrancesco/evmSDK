import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Flag from 'effect/unstable/cli/Flag'
import { CHAIN_PARAMETER, WALLET_PARAMETER, type ParameterSpec } from '../action-schema'
import type { SugarParameter, SugarParameters } from '../contracts'

/** Default chain for every command: Base, home of Aerodrome. */
export const DEFAULT_CHAIN = 8453

export const chain = Flag.Int('chain').pipe(
  Flag.withDefault(DEFAULT_CHAIN),
  Flag.withDescription(CHAIN_PARAMETER.description),
)

export const wallet = Flag.String('wallet').pipe(
  Flag.optional,
  Flag.withMetavar('<0x address>'),
  Flag.withDescription(WALLET_PARAMETER.description),
)

export const yes = Flag.Boolean('yes').pipe(
  Flag.withDefault(false),
  Flag.withAlias('y'),
  Flag.withDescription('Skip the sign-and-broadcast confirmation prompt'),
)

export const dryRun = Flag.Boolean('dry-run').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Always print the unsigned plan, never broadcast'),
)

/** What a generated flag hands the handler: a value, or `Option` for optional flags. */
export type FlagValue = SugarParameter | Option.Option<SugarParameter>

function metavar(spec: ParameterSpec): string {
  if (spec.kind === 'address') return '<0x address>'
  if (spec.kind === 'token') return '<symbol|0x address>'
  return `<${spec.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}>`
}

/**
 * One `--flag` per schema parameter. Booleans the action layer defaults to
 * on become `--no-<name>` (only an explicit opt-out is sent); everything else
 * is optional unless the schema marks it required. Tokens remain optional here
 * so the interactive picker can resolve them before request validation.
 */
export function flagFor(spec: ParameterSpec): Flag.Flag<FlagValue> {
  const name = spec.name.replaceAll('_', '-')
  if (spec.kind === 'boolean') {
    return spec.default
      ? Flag.Boolean(`no-${name}`).pipe(Flag.withDefault(false), Flag.withDescription(`Don't ${spec.description.charAt(0).toLowerCase()}${spec.description.slice(1)}`))
      : Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(spec.description))
  }
  const typed: Flag.Flag<SugarParameter> = spec.kind === 'choice' && spec.choices
    ? Flag.Literals(name, spec.choices)
    : spec.kind === 'integer'
      ? Flag.Int(name)
      : spec.kind === 'number'
        ? Flag.Finite(name)
        : Flag.String(name).pipe(Flag.withMetavar(metavar(spec)))
  const described = typed.pipe(Flag.withDescription(spec.description))
  return spec.required && spec.kind !== 'token' ? described : Flag.optional(described)
}

/** Build the flag record for a parameter list, keyed by parameter name. */
export function flagsFor(specs: readonly ParameterSpec[]): Record<string, Flag.Flag<FlagValue>> {
  return Object.fromEntries(specs.map((spec) => [spec.name, flagFor(spec)]))
}

/**
 * Turn parsed flags back into Sugar parameters: unwrap options, drop unset
 * values, and translate `--no-<name>` into an explicit `false` so the shared
 * validator sees exactly what the user passed.
 */
export function parametersFrom(specs: readonly ParameterSpec[], config: Record<string, FlagValue>): SugarParameters {
  const output: SugarParameters = {}
  for (const spec of specs) {
    const raw = config[spec.name]
    const value = Option.isOption(raw) ? Option.getOrUndefined(raw) : raw
    if (spec.kind === 'boolean') {
      if (spec.default) {
        if (value === true) output[spec.name] = false
      } else if (value === true) output[spec.name] = true
      continue
    }
    if (Predicate.isString(value) || Predicate.isNumber(value)) output[spec.name] = value
  }
  return output
}

/** Drop unset flags so the shared validator sees exactly what the user passed. */
export function definedParameters(entries: Record<string, SugarParameter | undefined>): SugarParameters {
  const output: SugarParameters = {}
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined) output[name] = value
  }
  return output
}

export function optionalValue<A>(option: Option.Option<A>): A | undefined {
  return Option.getOrUndefined(option)
}
