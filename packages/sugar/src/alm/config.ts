import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Schema from 'effect/Schema'
import type { Address } from 'viem'
import { normalizeAddress } from '../helpers'
import type { SugarJson } from '../types'
import { walletDir } from '../wallet'
import { ALM_STRATEGIES, defaultStrategySettings, type StrategySettings } from './strategy'

/**
 * Configuration for the self-hosted ALM daemon (`aero serve`). The file is
 * user-edited JSON, so every field except `pool` is optional and falls back
 * to Mellow-equivalent defaults resolved against the pool's tick spacing.
 */

const PositionEntrySchema = Schema.Struct({
  pool: Schema.String,
  positionId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[1-9]\d*$/))),
  strategy: Schema.optionalKey(Schema.Literals(ALM_STRATEGIES)),
  widthTicks: Schema.optionalKey(Schema.Int),
  tickNeighborhood: Schema.optionalKey(Schema.Int),
  expandStepTicks: Schema.optionalKey(Schema.Int),
  maxWidthTicks: Schema.optionalKey(Schema.Int),
  cooldownMinutes: Schema.optionalKey(Schema.Number),
  maxRebalancesPerDay: Schema.optionalKey(Schema.Int),
  slippage: Schema.optionalKey(Schema.Number),
  swapSlippage: Schema.optionalKey(Schema.Number),
  twapSeconds: Schema.optionalKey(Schema.Int),
  maxTwapDeviationTicks: Schema.optionalKey(Schema.Int),
  compound: Schema.optionalKey(Schema.Boolean),
  minCompoundEmissionsDecimal: Schema.optionalKey(Schema.Number),
})

const SafeEntrySchema = Schema.Struct({
  address: Schema.String,
  rolesModifier: Schema.String,
  roleKey: Schema.optionalKey(Schema.String),
})

const AlmConfigFileSchema = Schema.Struct({
  version: Schema.Literals([1]),
  chain: Schema.optionalKey(Schema.Int),
  pollSeconds: Schema.optionalKey(Schema.Number),
  telegram: Schema.optionalKey(Schema.Boolean),
  safe: Schema.optionalKey(SafeEntrySchema),
  positions: Schema.Array(PositionEntrySchema),
})

export type AlmPositionEntry = typeof PositionEntrySchema.Type
export type AlmConfigFile = typeof AlmConfigFileSchema.Type

export type AlmPositionConfig = {
  pool: Address
  positionId?: bigint
  strategy: AlmPositionEntry['strategy']
  widthTicks?: number
  tickNeighborhood?: number
  expandStepTicks?: number
  maxWidthTicks?: number
  /** Minimum minutes between rebalances of the same position. */
  cooldownMinutes: number
  /** Hard cap on rebalances per position per rolling 24h. */
  maxRebalancesPerDay: number
  /** Deposit/withdraw slippage tolerance (0-1). */
  slippage: number
  /** Swap slippage tolerance (0-1). */
  swapSlippage: number
  /** TWAP window used by the manipulation guard. */
  twapSeconds: number
  /** Abort a rebalance when |spot tick - TWAP tick| exceeds this. */
  maxTwapDeviationTicks: number
  /** Claim + redeposit gauge emissions when they exceed the threshold. */
  compound: boolean
  minCompoundEmissionsDecimal: number
}

export type AlmSafeConfig = {
  /** The Safe (avatar) that owns the positions. */
  address: Address
  /** Zodiac Roles Modifier attached to the Safe. */
  rolesModifier: Address
  /** Human-readable role name (encoded to bytes32 at the boundary). */
  roleKey: string
}

export type AlmConfig = {
  chain: number
  pollSeconds: number
  telegram: boolean
  /** When present, aero serve runs in Safe mode through the Roles Modifier. */
  safe?: AlmSafeConfig
  positions: AlmPositionConfig[]
}

export const DEFAULT_ROLE_KEY = 'aero-alm'

export const ALM_DEFAULTS = {
  pollSeconds: 30,
  cooldownMinutes: 60,
  maxRebalancesPerDay: 4,
  slippage: 0.01,
  swapSlippage: 0.005,
  // Mellow's PulseVeloBot guards: 5 min average tick, 50 ticks max deviation.
  twapSeconds: 300,
  maxTwapDeviationTicks: 50,
  minCompoundEmissionsDecimal: 1,
} as const

export function almConfigPath(): string {
  return process.env.AERO_ALM_CONFIG ?? join(walletDir(), 'alm.json')
}

export function almStatePath(): string {
  return join(walletDir(), 'alm-state.json')
}

function resolvePosition(entry: AlmPositionEntry): AlmPositionConfig {
  return {
    pool: normalizeAddress(entry.pool),
    positionId: entry.positionId === undefined ? undefined : BigInt(entry.positionId),
    strategy: entry.strategy,
    widthTicks: entry.widthTicks,
    tickNeighborhood: entry.tickNeighborhood,
    expandStepTicks: entry.expandStepTicks,
    maxWidthTicks: entry.maxWidthTicks,
    cooldownMinutes: entry.cooldownMinutes ?? ALM_DEFAULTS.cooldownMinutes,
    maxRebalancesPerDay: entry.maxRebalancesPerDay ?? ALM_DEFAULTS.maxRebalancesPerDay,
    slippage: entry.slippage ?? ALM_DEFAULTS.slippage,
    swapSlippage: entry.swapSlippage ?? ALM_DEFAULTS.swapSlippage,
    twapSeconds: entry.twapSeconds ?? ALM_DEFAULTS.twapSeconds,
    maxTwapDeviationTicks: entry.maxTwapDeviationTicks ?? ALM_DEFAULTS.maxTwapDeviationTicks,
    compound: entry.compound ?? true,
    minCompoundEmissionsDecimal: entry.minCompoundEmissionsDecimal ?? ALM_DEFAULTS.minCompoundEmissionsDecimal,
  }
}

/** Parse and resolve a raw config file payload (throws with a readable message). */
export function parseAlmConfig(raw: SugarJson): AlmConfig {
  const file = Schema.decodeUnknownSync(AlmConfigFileSchema)(raw)
  const positions = file.positions.map(resolvePosition)
  const seen = new Set<string>()
  for (const position of positions) {
    const key = position.pool.toLowerCase()
    if (seen.has(key)) throw new Error(`duplicate pool in ALM config: ${position.pool}`)
    seen.add(key)
    if (position.slippage <= 0 || position.slippage > 0.5) throw new Error(`slippage for ${position.pool} must be in (0, 0.5]`)
    if (position.swapSlippage <= 0 || position.swapSlippage > 0.5) throw new Error(`swapSlippage for ${position.pool} must be in (0, 0.5]`)
    if (position.cooldownMinutes < 0) throw new Error(`cooldownMinutes for ${position.pool} must be >= 0`)
    if (position.maxRebalancesPerDay < 1) throw new Error(`maxRebalancesPerDay for ${position.pool} must be >= 1`)
    if (position.twapSeconds < 1) throw new Error(`twapSeconds for ${position.pool} must be >= 1`)
    if (position.maxTwapDeviationTicks < 1) throw new Error(`maxTwapDeviationTicks for ${position.pool} must be >= 1`)
  }
  if (positions.length === 0) throw new Error('ALM config has no positions; run: aero alm init')
  const safe = file.safe === undefined ? undefined : {
    address: normalizeAddress(file.safe.address),
    rolesModifier: normalizeAddress(file.safe.rolesModifier),
    roleKey: file.safe.roleKey ?? DEFAULT_ROLE_KEY,
  }
  const config: AlmConfig = {
    chain: file.chain ?? 8453,
    pollSeconds: file.pollSeconds ?? ALM_DEFAULTS.pollSeconds,
    telegram: file.telegram ?? false,
    positions,
  }
  if (safe) config.safe = safe
  return config
}

export function loadAlmConfig(path = almConfigPath()): AlmConfig {
  if (!existsSync(path)) throw new Error(`no ALM config at ${path}; run: aero alm init`)
  let raw: SugarJson
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`ALM config at ${path} is not valid JSON`, { cause })
  }
  try {
    return parseAlmConfig(raw)
  } catch (cause) {
    throw new Error(`invalid ALM config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export function saveAlmConfigFile(file: AlmConfigFile, path = almConfigPath()): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Fill the per-pool strategy settings, falling back to the position's current
 * on-chain width and then to the Mellow defaults for the pool's tick spacing.
 */
export function strategySettingsFor(
  position: AlmPositionConfig,
  tickSpacing: number,
  currentWidthTicks?: number,
): StrategySettings {
  const defaults = defaultStrategySettings(tickSpacing, position.strategy ?? 'original')
  const widthTicks = position.widthTicks ?? currentWidthTicks ?? defaults.widthTicks
  return {
    strategy: position.strategy ?? 'original',
    widthTicks,
    tickNeighborhood: position.tickNeighborhood ?? defaults.tickNeighborhood,
    expandStepTicks: position.expandStepTicks ?? defaults.expandStepTicks,
    maxWidthTicks: position.maxWidthTicks ?? Math.max(widthTicks * 2, defaults.maxWidthTicks),
  }
}
