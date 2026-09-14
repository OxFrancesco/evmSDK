import * as Predicate from 'effect/Predicate'
import { requestParameters, type ParameterSpec } from './action-schema'
import { isSupportedChainId } from './config'
import {
  SUGAR_ACTIONS,
  type SugarAction,
  type SugarParameter,
  type SugarParameters,
} from './contracts'

export {
  isSugarAction,
  SUGAR_ACTIONS,
  type SugarAction,
  type SugarParameter,
  type SugarParameters,
} from './contracts'
export { ACTION_SCHEMA, acceptsWallet, actionSpec, requestParameters, type ActionSpec, type ParameterKind, type ParameterSpec } from './action-schema'

function formatChoices(choices: readonly string[]): string {
  if (choices.length <= 1) return choices.join('')
  return `${choices.slice(0, -1).join(', ')}, or ${choices[choices.length - 1]}`
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/
const POSITION_ACTIONS = new Set<SugarAction>([
  'withdraw',
  'stake',
  'unstake',
  'claim_emissions',
  'claim_fees',
])

function validateParameter<T>(
  spec: ParameterSpec,
  value: T,
): SugarParameter {
  const { name, kind } = spec
  if (kind === 'address') {
    if (!Predicate.isString(value) || !ADDRESS.test(value)) {
      throw new Error(`${name} must be a 20-byte 0x address`)
    }
    return value
  }
  if (kind === 'boolean') {
    if (!Predicate.isBoolean(value)) throw new Error(`${name} must be a boolean`)
    return value
  }
  if (kind === 'number' || kind === 'integer') {
    if (!Predicate.isNumber(value) || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`)
    }
    if (kind === 'integer' && !Number.isInteger(value)) {
      throw new Error(`${name} must be an integer`)
    }
    return value
  }
  if (kind === 'choice') {
    if (!Predicate.isString(value) || !spec.choices?.includes(value)) {
      throw new Error(`${name} must be ${formatChoices(spec.choices ?? [])}`)
    }
    return value
  }
  if (kind === 'decimal_string') {
    const text = Predicate.isNumber(value) ? String(value) : value
    if (!Predicate.isString(text) || text.length > 1_024 || !/^\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(text)) {
      throw new Error(`${name} must be a decimal number`)
    }
    const number = Number(text)
    if (!Number.isFinite(number)) throw new Error(`${name} must be a finite decimal number`)
    return text
  }
  if (kind === 'integer_string') {
    if (!Predicate.isString(value) || !/^\d+$/.test(value)) {
      throw new Error(`${name} must be a non-negative decimal integer string`)
    }
    return value
  }
  if (!Predicate.isString(value) || value.length === 0 || value.length > 256) {
    throw new Error(
      `${name} must be a non-empty string of at most 256 characters`,
    )
  }
  if (PRIVATE_KEY_PATTERN.test(value)) {
    throw new Error('Sugar accepts public addresses only, never private keys')
  }
  return value
}

/** Validate the shared boundary before arguments can reach the Sugar CLI. */
export function validateSugarRequest<T>(
  action: SugarAction,
  raw: T,
): SugarParameters {
  if (!SUGAR_ACTIONS.includes(action))
    throw new Error(`Unsupported Sugar action: ${action}`)
  if (!Predicate.isObject(raw)) throw new Error('Sugar parameters must be an object')

  const parameters = requestParameters(action)
  const output: SugarParameters = {}
  for (const [name, value] of Object.entries(raw)) {
    const spec = parameters.find((entry) => entry.name === name)
    if (!spec) throw new Error(`Unsupported parameter for ${action}: ${name}`)
    if (value !== undefined && value !== null)
      output[name] = validateParameter(spec, value)
  }
  for (const spec of parameters) {
    if (spec.required && !(spec.name in output)) throw new Error(`${action} requires ${spec.name}`)
  }
  if (action === 'create_venft') {
    const duration = output.lock_duration_seconds
    if (
      !Predicate.isNumber(duration) ||
      !Number.isSafeInteger(duration) ||
      duration <= 0
    ) {
      throw new Error('lock_duration_seconds must be a positive integer')
    }
  }

  const chain = output.chain
  if (!Predicate.isNumber(chain) || !isSupportedChainId(chain)) {
    throw new Error(
      'chain must be one of 10, 130, 252, 1135, 1868, 5330, 8453, 34443, 42220, or 57073',
    )
  }
  if (
    Predicate.isNumber(output.limit) &&
    (output.limit < 1 || output.limit > 100)
  ) {
    throw new Error('limit must be between 1 and 100')
  }
  if (Predicate.isNumber(output.offset) && output.offset < 0) {
    throw new Error('offset must not be negative')
  }
  if (
    Predicate.isNumber(output.slippage) &&
    (output.slippage < 0 || output.slippage > 1)
  ) {
    throw new Error('slippage must be between 0 and 1')
  }
  if (output.fraction !== undefined) {
    const fraction = Number(output.fraction)
    if (fraction <= 0 || fraction > 1) throw new Error('fraction must be greater than 0 and at most 1')
  }
  if (
    Predicate.isNumber(output.deadline_minutes) &&
    output.deadline_minutes <= 0
  ) {
    throw new Error('deadline_minutes must be positive')
  }
  if (
    action === 'positions' &&
    output.wallet === undefined &&
    output.owner === undefined
  ) {
    throw new Error('positions requires wallet or owner')
  }
  if (
    POSITION_ACTIONS.has(action) &&
    output.pool === undefined &&
    output.position === undefined
  ) {
    throw new Error(`${action} requires pool or position`)
  }
  if (action === 'deposit') {
    const creationFields = ['token0', 'token1', 'pool_type', 'tick_spacing']
    if (output.pool !== undefined && creationFields.some((name) => output[name] !== undefined)) {
      throw new Error('deposit pool cannot be combined with token0, token1, pool_type, or tick_spacing')
    }
    if (output.pool === undefined) {
      if (output.token0 === undefined || output.token1 === undefined || output.pool_type === undefined) {
        throw new Error('new deposit pool requires token0, token1, and pool_type')
      }
      if (output.pool_type === 'cl' && output.tick_spacing === undefined) {
        throw new Error('CL deposit pool requires tick_spacing')
      }
      if (output.pool_type !== 'cl' && output.tick_spacing !== undefined) {
        throw new Error('tick_spacing is CL-only')
      }
    }
  }
  return output
}

/** @deprecated Compatibility helper for callers migrating from the former Python bridge. */
export function buildSugarArgv(
  executable: string,
  action: SugarAction,
  parameters: SugarParameters,
) {
  const command = action.replaceAll('_', '-')
  const flags = Object.entries(parameters).map(
    ([name, value]) => `--${name.replaceAll('_', '-')}=${String(value)}`,
  )
  return [executable, command, ...flags]
}

export { SugarClient, createSugarClient } from './client'
export { createSugarCacheStore, type SugarCacheStoreOptions } from './cache'
export { createSugarFailoverTransport, type SugarFailoverTransportOptions } from './transport'
export { SugarRpcError, type SugarRpcErrorCode } from './errors'
export { executeSugarAction, executeSugarActionJson, type SugarExecutionOptions } from './actions'
export { abis } from './abis'
export * from './config'
export * from './chains'
export * from './helpers'
export * from './models'
export * from './known-tokens'
export * from './planner'
export * from './superswap'
export * from './types'
