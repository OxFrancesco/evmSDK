import type { Address, PublicClient } from 'viem'
import { abis } from '../abis'

/**
 * Direct pool reads for the ALM poll loop. Polling goes straight to the CL
 * pool contract (one eth_call for slot0) instead of through the Sugar
 * catalog, so a 30s cadence costs nothing and always sees a fresh tick.
 */

export type PoolTick = { sqrtPriceX96: bigint; tick: number }

export async function readPoolTick(client: PublicClient, pool: Address): Promise<PoolTick> {
  // SAFETY: the poolCl slot0 ABI pins the tuple head to (uint160, int24),
  // which viem decodes as [bigint, number].
  const slot0 = await client.readContract({ address: pool, abi: abis.poolCl, functionName: 'slot0' }) as readonly [bigint, number]
  return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]) }
}

/**
 * Time-weighted average tick over the last `seconds`, from the pool's own
 * oracle (`observe`). Returns undefined when the pool's observation history
 * is too short — callers fall back to their locally sampled history.
 */
export async function readTwapTick(client: PublicClient, pool: Address, seconds: number): Promise<number | undefined> {
  try {
    // SAFETY: the poolCl observe ABI pins the output to (int56[], uint160[]),
    // which viem decodes as two bigint arrays.
    const observed = await client.readContract({
      address: pool,
      abi: abis.poolCl,
      functionName: 'observe',
      args: [[seconds, 0]],
    }) as readonly [readonly bigint[], readonly bigint[]]
    const [older, latest] = observed[0]
    return Math.floor(Number(latest - older) / seconds)
  } catch {
    return undefined
  }
}

/** Rolling in-memory tick samples, the TWAP fallback for young pools. */
export type TickHistory = { samples: Array<{ at: number; tick: number }> }

export function pushTickSample(history: TickHistory, tick: number, at: number, windowMs: number): void {
  if (!Number.isFinite(at) || !Number.isInteger(tick)) throw new Error('Invalid tick sample')
  const previous = history.samples.at(-1)
  if (previous && at < previous.at) history.samples = []
  if (previous?.at === at) history.samples.pop()
  history.samples.push({ at, tick })
  const cutoff = at - windowMs
  while (history.samples.length > 1 && history.samples[1].at <= cutoff) history.samples.shift()
}

export function averageTick(history: TickHistory, windowMs: number, now: number, maxGapMs = windowMs): number | undefined {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(now)) return undefined
  const cutoff = now - windowMs
  const samples = history.samples
  // A single sample is just the spot tick again; it cannot smooth anything.
  if (samples.length < 2) return undefined
  // Require coverage of most of the window so a burst of fresh samples
  // cannot masquerade as a time-weighted average.
  if (samples[0].at > cutoff || samples.at(-1)?.at !== now) return undefined
  let weighted = 0
  for (const [index, sample] of samples.entries()) {
    if (!Number.isInteger(sample.tick) || !Number.isFinite(sample.at) || sample.at > now) return undefined
    const end = samples[index + 1]?.at ?? now
    if (end < sample.at || (end > cutoff && end - sample.at > maxGapMs)) return undefined
    weighted += sample.tick * Math.max(0, end - Math.max(sample.at, cutoff))
  }
  return Math.floor(weighted / windowMs)
}

export type TwapGate =
  | { allowed: true; twapTick: number }
  | { allowed: false; reason: string }

/**
 * Mellow-style manipulation guard: refuse to rebalance while the spot tick
 * deviates from the time-weighted average by more than the configured limit.
 */
export function checkTwapGate(spotTick: number, twapTick: number | undefined, maxDeviationTicks: number): TwapGate {
  if (twapTick === undefined || !Number.isFinite(twapTick) || !Number.isFinite(spotTick) || !Number.isFinite(maxDeviationTicks) || maxDeviationTicks < 0) {
    return { allowed: false, reason: 'no TWAP available yet (pool oracle too young and local history too short); waiting' }
  }
  const deviation = Math.abs(spotTick - twapTick)
  if (deviation > maxDeviationTicks) {
    return { allowed: false, reason: `spot tick ${spotTick} deviates ${deviation} ticks from TWAP ${twapTick} (max ${maxDeviationTicks}); possible manipulation or wick` }
  }
  return { allowed: true, twapTick }
}
