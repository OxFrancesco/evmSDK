// Mellow PulseStrategyModule reference: Copyright 2021-2025 G3M Labs S. A.
// Modified TypeScript implementation by Francesco Oddo and BeeGreat contributors.
// Derivative-work status and production permission remain unresolved.
// Any Mellow-derived portions remain under ../../LICENSE.Mellow-BUSL-1.1. See ../../NOTICE.
import { MAX_ABS_TICK } from '../types'

/**
 * Pure range-management strategies for the self-hosted ALM (`aero serve`).
 *
 * These replicate Mellow Protocol's PulseStrategyModule, the engine behind
 * Aerodrome/Velodrome's official ALM vaults:
 *
 * - `original`      — keep the position centered: when the market tick leaves
 *                     [tickLower + neighborhood, tickUpper - neighborhood),
 *                     mint a new interval of the same width centered on the
 *                     current tick.
 * - `lazy-syncing`  — only act when the tick is fully outside the interval;
 *                     place the new interval adjacent to the current tick so
 *                     the withdrawn liquidity is already the right single
 *                     token (no swap needed).
 * - `lazy-ascending`— lazy-syncing that only follows upward breaches.
 * - `lazy-descending`— lazy-syncing that only follows downward breaches.
 * - `expand`        — Pulse V2 ("tamper"): widen the interval uniformly on
 *                     both sides instead of recentering; once the width
 *                     exceeds `maxWidthTicks`, reset to a centered interval
 *                     of `widthTicks`.
 *
 * Everything here is pure integer math on ticks so it can be unit-tested
 * without a chain.
 */

export const ALM_STRATEGIES = ['original', 'lazy-syncing', 'lazy-ascending', 'lazy-descending', 'expand'] as const

export type AlmStrategyKind = (typeof ALM_STRATEGIES)[number]

export function isAlmStrategy(value: string): value is AlmStrategyKind {
  return ALM_STRATEGIES.some((strategy) => strategy === value)
}

export type StrategySettings = {
  strategy: AlmStrategyKind
  /** Target interval width in ticks (multiple of the pool's tick spacing). */
  widthTicks: number
  /** Early-trigger buffer in ticks measured from each interval edge. */
  tickNeighborhood: number
  /** expand only: ticks added to EACH side per expansion (multiple of spacing). */
  expandStepTicks: number
  /** expand only: reset to a centered `widthTicks` interval beyond this width. */
  maxWidthTicks: number
}

export type RangeState = {
  /** Current pool tick. */
  tick: number
  /** Pool tick spacing (Sugar pool `type` for CL pools). */
  tickSpacing: number
  /** Current position interval. */
  tickLower: number
  tickUpper: number
}

export type RangeDecision =
  | { action: 'hold'; reason: string }
  | { action: 'rebalance'; tickLower: number; tickUpper: number; reason: string }

/**
 * Mellow's production interval widths for Aerodrome CL strategies, keyed by
 * tick spacing (docs.mellow.finance, Aerodrome CL strategies table).
 */
export const DEFAULT_WIDTH_BY_SPACING = new Map<number, number>([
  [1, 1],
  [50, 1_000],
  [100, 4_000],
  [200, 6_000],
])

export function defaultWidthTicks(tickSpacing: number): number {
  return DEFAULT_WIDTH_BY_SPACING.get(tickSpacing) ?? tickSpacing * 30
}

export function defaultStrategySettings(tickSpacing: number, strategy: AlmStrategyKind = 'original'): StrategySettings {
  const widthTicks = defaultWidthTicks(tickSpacing)
  return {
    strategy,
    widthTicks,
    tickNeighborhood: 0,
    expandStepTicks: tickSpacing * Math.max(1, Math.round(widthTicks / tickSpacing / 10)),
    maxWidthTicks: widthTicks * 2,
  }
}

export function validateStrategySettings(settings: StrategySettings, tickSpacing: number): void {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('tick spacing must be a positive integer')
  const { strategy, widthTicks, tickNeighborhood, expandStepTicks, maxWidthTicks } = settings
  if (!Number.isInteger(widthTicks) || widthTicks <= 0) throw new Error('widthTicks must be a positive integer')
  if (widthTicks % tickSpacing !== 0) throw new Error(`widthTicks must be a multiple of the pool tick spacing (${tickSpacing})`)
  if (!Number.isInteger(tickNeighborhood) || tickNeighborhood < 0) throw new Error('tickNeighborhood must be a non-negative integer')
  if (tickNeighborhood * 2 >= widthTicks) throw new Error('tickNeighborhood must be less than half of widthTicks')
  if (strategy === 'expand') {
    if (!Number.isInteger(expandStepTicks) || expandStepTicks <= 0) throw new Error('expandStepTicks must be a positive integer')
    if (expandStepTicks % tickSpacing !== 0) throw new Error(`expandStepTicks must be a multiple of the pool tick spacing (${tickSpacing})`)
    if (!Number.isInteger(maxWidthTicks) || maxWidthTicks < widthTicks) throw new Error('maxWidthTicks must be at least widthTicks')
  }
}

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing
}

function alignUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing
}

function clampInterval(lower: number, upper: number, spacing: number) {
  const maxTick = alignDown(MAX_ABS_TICK, spacing)
  const minTick = -maxTick
  let tickLower = lower
  let tickUpper = upper
  if (tickUpper > maxTick) {
    tickLower -= tickUpper - maxTick
    tickUpper = maxTick
  }
  if (tickLower < minTick) {
    tickUpper += minTick - tickLower
    tickLower = minTick
  }
  if (tickUpper > maxTick) tickUpper = maxTick
  if (tickLower >= tickUpper) throw new Error('interval collapsed while clamping to the tick domain')
  return { tickLower, tickUpper }
}

/** Interval of `width` ticks centered on `tick`, aligned to the spacing grid. */
export function centeredInterval(tick: number, width: number, spacing: number) {
  const lower = Math.round((tick - width / 2) / spacing) * spacing
  return clampInterval(lower, lower + width, spacing)
}

function insideActiveInterval(state: RangeState, neighborhood: number): boolean {
  return state.tick >= state.tickLower + neighborhood && state.tick < state.tickUpper - neighborhood
}

function describeBreach(state: RangeState, neighborhood: number): string {
  const side = state.tick < state.tickLower + neighborhood ? 'below' : 'above'
  const edge = side === 'below' ? state.tickLower : state.tickUpper
  return `tick ${state.tick} is ${side} the active interval [${state.tickLower}, ${state.tickUpper}) (edge ${edge}, neighborhood ${neighborhood})`
}

const HOLD_IN_RANGE: RangeDecision = { action: 'hold', reason: 'tick is inside the active interval' }

function decideOriginal(state: RangeState, settings: StrategySettings): RangeDecision {
  if (insideActiveInterval(state, settings.tickNeighborhood)) return HOLD_IN_RANGE
  const next = centeredInterval(state.tick, settings.widthTicks, state.tickSpacing)
  if (next.tickLower === state.tickLower && next.tickUpper === state.tickUpper) {
    return { action: 'hold', reason: 'recentering would produce the same interval' }
  }
  return { action: 'rebalance', ...next, reason: `${describeBreach(state, settings.tickNeighborhood)}; recentering with width ${settings.widthTicks}` }
}

/**
 * Lazy placement keeps the interval on one side of the current tick so the
 * withdrawn single-sided liquidity redeposits without a swap.
 */
function decideLazy(state: RangeState, settings: StrategySettings, follow: 'both' | 'up' | 'down'): RangeDecision {
  const { tick, tickSpacing, tickLower, tickUpper } = state
  if (tick >= tickLower && tick < tickUpper) return HOLD_IN_RANGE
  const width = settings.widthTicks
  if (tick < tickLower) {
    if (follow === 'up') return { action: 'hold', reason: 'lazy-ascending ignores downward breaches' }
    const lower = alignUp(tick, tickSpacing)
    const next = clampInterval(lower, lower + width, tickSpacing)
    if (next.tickLower === tickLower && next.tickUpper === tickUpper) return { action: 'hold', reason: 'interval already adjacent to the tick' }
    return { action: 'rebalance', ...next, reason: `${describeBreach(state, 0)}; syncing down to the interval just above the tick` }
  }
  if (follow === 'down') return { action: 'hold', reason: 'lazy-descending ignores upward breaches' }
  const upper = alignDown(tick, tickSpacing)
  const next = clampInterval(upper - width, upper, tickSpacing)
  if (next.tickLower === tickLower && next.tickUpper === tickUpper) return { action: 'hold', reason: 'interval already adjacent to the tick' }
  return { action: 'rebalance', ...next, reason: `${describeBreach(state, 0)}; syncing up to the interval just below the tick` }
}

function decideExpand(state: RangeState, settings: StrategySettings): RangeDecision {
  if (insideActiveInterval(state, settings.tickNeighborhood)) return HOLD_IN_RANGE
  const { tickSpacing } = state
  let lower = state.tickLower
  let upper = state.tickUpper
  // Expand uniformly until the tick is back inside the active interval.
  do {
    lower -= settings.expandStepTicks
    upper += settings.expandStepTicks
  } while (
    upper - lower <= settings.maxWidthTicks
    && !(state.tick >= lower + settings.tickNeighborhood && state.tick < upper - settings.tickNeighborhood)
  )
  if (upper - lower > settings.maxWidthTicks) {
    const next = centeredInterval(state.tick, settings.widthTicks, tickSpacing)
    if (next.tickLower === state.tickLower && next.tickUpper === state.tickUpper) {
      return { action: 'hold', reason: 'reset would produce the same interval' }
    }
    return { action: 'rebalance', ...next, reason: `${describeBreach(state, settings.tickNeighborhood)}; width limit ${settings.maxWidthTicks} reached, resetting to a centered interval of ${settings.widthTicks}` }
  }
  const next = clampInterval(lower, upper, tickSpacing)
  return { action: 'rebalance', ...next, reason: `${describeBreach(state, settings.tickNeighborhood)}; expanding to [${next.tickLower}, ${next.tickUpper})` }
}

/** Decide what, if anything, to do with a position given the current tick. */
export function decideRange(state: RangeState, settings: StrategySettings): RangeDecision {
  validateStrategySettings(settings, state.tickSpacing)
  if (!Number.isInteger(state.tick)) throw new Error('tick must be an integer')
  if (state.tickLower >= state.tickUpper) throw new Error('position interval is empty')
  switch (settings.strategy) {
    case 'original':
      return decideOriginal(state, settings)
    case 'lazy-syncing':
      return decideLazy(state, settings, 'both')
    case 'lazy-ascending':
      return decideLazy(state, settings, 'up')
    case 'lazy-descending':
      return decideLazy(state, settings, 'down')
    case 'expand':
      return decideExpand(state, settings)
  }
}
