/**
 * Swap sizing for redepositing withdrawn liquidity into a new interval.
 *
 * A CL interval [tickLower, tickUpper) at current tick `tick` needs its
 * capital split between token0 and token1 in a ratio fixed by Uniswap V3
 * math. After withdrawing the old position we hold some (amount0, amount1);
 * this module computes the single swap that converts the surplus side into
 * the deficit side so the pair matches the new interval's ratio. This is the
 * off-chain equivalent of the swap Mellow's PulseVeloBot requests from 1inch
 * before calling rebalance().
 *
 * All amounts are human-decimal numbers; float precision is fine here
 * because deposit quoting, slippage bounds, and simulation all run against
 * exact on-chain math afterwards.
 */

/** Value share (0..1) of token0 for an interval at the given tick. Tick math is decimals-free. */
export function token0ValueShare(tick: number, tickLower: number, tickUpper: number): number {
  if (tickLower >= tickUpper) throw new Error('interval is empty')
  if (tick <= tickLower) return 1
  if (tick >= tickUpper) return 0
  const sqrtP = 1.0001 ** (tick / 2)
  const sqrtPl = 1.0001 ** (tickLower / 2)
  const sqrtPu = 1.0001 ** (tickUpper / 2)
  const amount0 = (sqrtPu - sqrtP) / (sqrtP * sqrtPu)
  const amount1 = sqrtP - sqrtPl
  const value0 = amount0 * sqrtP * sqrtP
  return value0 / (value0 + amount1)
}

export type RangeSwap =
  | { direction: 'none'; share0: number }
  | { direction: '0->1' | '1->0'; amountDecimal: number; share0: number }

export type RangeSwapInput = {
  tick: number
  tickLower: number
  tickUpper: number
  /** token1 per token0, in human decimals (helpers.tickToPrice). */
  price: number
  /** Current holdings in human decimals. */
  amount0Decimal: number
  amount1Decimal: number
  /** Skip swaps smaller than this fraction of total value (default 0.5%). */
  minSwapFraction?: number
}

/** The single swap that re-splits current holdings for the target interval. */
export function planRangeSwap(input: RangeSwapInput): RangeSwap {
  const { tick, tickLower, tickUpper, price, amount0Decimal, amount1Decimal } = input
  if (!Number.isFinite(price) || price <= 0) throw new Error('price must be a positive number')
  if (amount0Decimal < 0 || amount1Decimal < 0) throw new Error('amounts must be non-negative')
  const minSwapFraction = input.minSwapFraction ?? 0.005
  const share0 = token0ValueShare(tick, tickLower, tickUpper)
  const totalValue1 = amount0Decimal * price + amount1Decimal
  if (totalValue1 <= 0) return { direction: 'none', share0 }
  const target0 = share0 * totalValue1 / price
  const surplus0 = amount0Decimal - target0
  if (Math.abs(surplus0) * price / totalValue1 < minSwapFraction) return { direction: 'none', share0 }
  return surplus0 > 0
    ? { direction: '0->1', amountDecimal: surplus0, share0 }
    : { direction: '1->0', amountDecimal: -surplus0 * price, share0 }
}
