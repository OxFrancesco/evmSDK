// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import type { Address } from 'viem'
import { abis } from './abis'
import { addressKey, normalizeAddress, tupleValues } from './helpers'
import type { SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { paginate } from './internal/pagination'
import { positionFromTuple, preparePools, prepareTokens } from './models'
import { resolvePoolLocator } from './pools'
import { ADDRESS_ZERO, type Position } from './types'

const hydratePositions = Effect.fn('Sugar.Positions.hydratePositions')(function* (
  ctx: SugarContext,
  raw: unknown[],
  rawPools: unknown[],
) {
  const poolAddresses = new Set(raw.map((position) => addressKey(String(tupleValues(position)[1]))))
  const positionPools = rawPools.filter((pool) => poolAddresses.has(addressKey(String(tupleValues(pool)[0]))))
  const neededTokenAddresses = new Map<string, Address>([
    [addressKey(ctx.settings.stableTokenAddress), normalizeAddress(ctx.settings.stableTokenAddress)],
  ])
  positionPools.forEach((pool) => {
    const values = tupleValues(pool)
    ;[values[7], values[10], values[20]].forEach((address) => {
      const normalized = normalizeAddress(String(address))
      neededTokenAddresses.set(addressKey(normalized), normalized)
    })
  })
  const addresses = [...neededTokenAddresses.values()]
  const rawTokens = yield* ctx.read<unknown[]>(
    ctx.settings.sugarContractAddress,
    abis.sugar,
    'tokens',
    [BigInt(addresses.length), 0n, ADDRESS_ZERO, addresses],
  )
  const tokens = prepareTokens(rawTokens, ctx.settings)
  const prices = yield* clientCall(() => ctx.client.getPrices(tokens))
  const pools = preparePools(positionPools, tokens, prices, ctx.settings)
  const poolMap = new Map(pools.map((pool) => [addressKey(pool.lp), pool]))
  return raw.map((position) => positionFromTuple(position, poolMap, ctx.settings)).filter((position): position is Position => position !== undefined)
})

/** Sugar's enumeration window (MAX_POSITIONS) for unstaked CL positions. */
const UNSTAKED_CL_PAGE = 200n

/**
 * Sugar's `positions` lists basic LP and staked CL positions only; unstaked
 * CL NFTs come from `positionsUnstakedConcentrated`, paginated over the
 * account's tokens on the pools' NFPM contracts. The balance check keeps the
 * scan from running at all for accounts with no CL NFTs.
 */
const unstakedConcentrated = Effect.fn('Sugar.Positions.unstakedConcentrated')(function* (
  ctx: SugarContext,
  owner: Address,
  nfpms: Address[],
) {
  const balances = yield* Effect.all(
    nfpms.map((nfpm) => ctx.read<bigint>(nfpm, abis.nfpm, 'balanceOf', [owner])),
    { concurrency: 'unbounded' },
  )
  const count = balances.reduce((sum, balance) => sum + balance, 0n)
  const unstaked: unknown[] = []
  if (count === 0n) return unstaked
  for (let offset = 0n; offset < count; offset += UNSTAKED_CL_PAGE) {
    unstaked.push(...yield* ctx.read<unknown[]>(
      ctx.settings.sugarContractAddress,
      abis.sugar,
      'positionsUnstakedConcentrated',
      [UNSTAKED_CL_PAGE, offset, owner],
    ))
  }
  return unstaked
})

/** The distinct NFPM contracts behind the CL pools in a raw pool catalog. */
function clNfpms(rawPools: unknown[]): Address[] {
  const nfpms = new Map<string, Address>()
  for (const pool of rawPools) {
    const nfpm = normalizeAddress(String(tupleValues(pool)[29]))
    if (nfpm !== ADDRESS_ZERO) nfpms.set(addressKey(nfpm), nfpm)
  }
  return [...nfpms.values()]
}

/** Dedupe raw position tuples by `${lp}-${id}` (tuple indexes 1 and 0). */
function dedupePositions(raw: unknown[]): unknown[] {
  const seen = new Set<string>()
  return raw.filter((position) => {
    const values = tupleValues(position)
    const key = `${addressKey(String(values[1]))}-${String(values[0])}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const getPositions = Effect.fn('Sugar.Positions.getPositions')(function* (
  ctx: SugarContext,
  owner?: Address,
) {
  if (!owner) throw new Error('Owner address is required to list positions')
  const rawPools = yield* clientCall(() => ctx.client.getRawPools(false))
  const [raw, unstaked] = yield* Effect.all([
    // `positions` scans pool offsets and returns only matches for the owner,
    // so an empty/short response cannot safely terminate pagination: a later
    // pool may still contain a position. Use the configured maximum scan
    // window to preserve complete results with far fewer sparse RPC reads.
    paginate(
      ctx,
      'positions',
      (limit, offset) => ctx.readTask<unknown[]>(
        ctx.settings.sugarContractAddress,
        abis.sugar,
        'positions',
        [limit, offset, owner],
      ),
      ctx.rpc.deadline('positions'),
      ctx.settings.poolPaginationMaxSize,
    ),
    unstakedConcentrated(ctx, owner, clNfpms(rawPools)),
  ], { concurrency: 'unbounded' })
  return yield* hydratePositions(ctx, dedupePositions([...raw, ...unstaked]), rawPools)
})

export const getPositionsByPool = Effect.fn('Sugar.Positions.getPositionsByPool')(function* (
  ctx: SugarContext,
  poolAddress: Address,
  owner?: Address,
) {
  if (!owner) throw new Error('Owner address is required to get a position')
  const normalizedPool = normalizeAddress(poolAddress)
  const resolved = yield* resolvePoolLocator(ctx, normalizedPool)
  if (!resolved) return []

  // Sugar's offset is the pool index. Once the pool catalog is cached, a
  // known basic-pool position is one bounded read instead of a global scan.
  const raw = yield* ctx.read<unknown[]>(
    ctx.settings.sugarContractAddress,
    abis.sugar,
    'positions',
    [1, resolved.offset, owner],
  )
  // That read covers staked CL entries only; an unstaked CL NFT in this pool
  // still needs the NFPM scan (pool tuple index 4 is the type, 29 the NFPM).
  const poolValues = tupleValues(resolved.rawPool)
  const unstaked = Number(poolValues[4]) > 0
    ? yield* unstakedConcentrated(ctx, owner, [normalizeAddress(String(poolValues[29]))])
    : []
  const matches = dedupePositions([...raw, ...unstaked]).filter((position) =>
    addressKey(String(tupleValues(position)[1])) === addressKey(normalizedPool),
  )
  if (matches.length === 0) return []
  return yield* hydratePositions(ctx, matches, [resolved.rawPool])
})

export const getPositionByPool = Effect.fn('Sugar.Positions.getPositionByPool')(function* (
  ctx: SugarContext,
  poolAddress: Address,
  owner?: Address,
) {
  const positions = yield* getPositionsByPool(ctx, poolAddress, owner)
  if (positions.length > 1) throw new Error('Owner has multiple positions in this pool; select an NFT id')
  return positions[0]
})

export const getPositionById = Effect.fn('Sugar.Positions.getPositionById')(function* (
  ctx: SugarContext,
  id: bigint,
  owner?: Address,
  poolAddress?: Address,
) {
  if (id <= 0n) throw new Error('NFT id must be positive')
  const positions = poolAddress
    ? yield* getPositionsByPool(ctx, poolAddress, owner)
    : yield* getPositions(ctx, owner)
  return positions.find((position) => position.id === id)
})
