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

export const getPositions = Effect.fn('Sugar.Positions.getPositions')(function* (
  ctx: SugarContext,
  owner?: Address,
) {
  if (!owner) throw new Error('Owner address is required to list positions')
  const [raw, rawPools] = yield* Effect.all([
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
    clientCall(() => ctx.client.getRawPools(false)),
  ], { concurrency: 'unbounded' })
  return yield* hydratePositions(ctx, raw, rawPools)
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
  const matches = raw.filter((position) =>
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
