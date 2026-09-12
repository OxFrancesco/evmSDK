import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { SugarClient } from './client'
import { stringListArgument, stubPublicClient } from './test-support'
import { ADDRESS_ZERO } from './types'

const OWNER: Address = '0x1000000000000000000000000000000000000001'
const POSITION_POOL: Address = '0x2000000000000000000000000000000000000001'
const IRRELEVANT_POOL: Address = '0x2000000000000000000000000000000000000002'
const TOKEN_A: Address = '0x3000000000000000000000000000000000000001'
const TOKEN_B: Address = '0x3000000000000000000000000000000000000002'
const TOKEN_C: Address = '0x3000000000000000000000000000000000000003'
const TOKEN_D: Address = '0x3000000000000000000000000000000000000004'
const STABLE_TOKEN: Address = '0x3000000000000000000000000000000000000005'

function tokenTuple(address: Address, symbol: string, decimals = 18): unknown[] {
  return [address, symbol, decimals, 0n, true, false]
}

function poolTuple(lp: Address, token0: Address, token1: Address): unknown[] {
  return [
    lp,
    'pool',
    18,
    1_000n,
    -1,
    0,
    1n,
    token0,
    100n,
    0n,
    token1,
    100n,
    0n,
    ADDRESS_ZERO,
    0n,
    false,
    ADDRESS_ZERO,
    ADDRESS_ZERO,
    ADDRESS_ZERO,
    1n,
    token0,
    0n,
    30n,
    0n,
    1n,
    1n,
    0n,
    0n,
    0,
    ADDRESS_ZERO,
    ADDRESS_ZERO,
    ADDRESS_ZERO,
  ]
}

function positionTuple(lp: Address): unknown[] {
  return [
    42n,
    lp,
    100n,
    0n,
    50n,
    50n,
    0n,
    0n,
    1n,
    1n,
    1n,
    -100,
    100,
    1n,
    2n,
    ADDRESS_ZERO,
    0,
    ADDRESS_ZERO,
  ]
}

describe('Sugar positions', () => {
  test('selects the requested NFT when an owner has multiple positions in one pool', async () => {
    const first = positionTuple(POSITION_POOL)
    const second = [...first]
    second[0] = 43n
    const sugar = new SugarClient(10, {
      account: OWNER,
      settings: { stableTokenAddress: STABLE_TOKEN },
      poolLocatorStore: { get: async () => ({ offset: 7 }), set: async () => {}, delete: async () => {} },
      publicClient: stubPublicClient({ readContract: async (request) => {
        if (request.functionName === 'all') return [poolTuple(POSITION_POOL, TOKEN_A, TOKEN_B)]
        if (request.functionName === 'positions') return [first, second]
        if (request.functionName === 'tokens') return [tokenTuple(STABLE_TOKEN, 'USDC', 6), tokenTuple(TOKEN_A, 'A'), tokenTuple(TOKEN_B, 'B')]
        if (request.functionName === 'getManyRatesToEthWithCustomConnectors') return stringListArgument(request, 0).map(() => 10n ** 18n)
        throw new Error(`Unexpected read ${request.functionName}`)
      } }),
    })
    expect((await sugar.getPositionById(43n, OWNER, POSITION_POOL))?.id).toBe(43n)
    await expect(sugar.getPositionByPool(POSITION_POOL)).rejects.toThrow('multiple positions')
  })

  test('uses a verified persisted pool locator without a global scan', async () => {
    const reads: string[] = []
    const sugar = new SugarClient(10, {
      account: OWNER,
      poolLocatorStore: {
        get: async () => ({ offset: 7 }),
        set: async () => undefined,
        delete: async () => undefined,
      },
      publicClient: stubPublicClient({
        readContract: async (request) => {
          reads.push(request.functionName)
          const limit = Number(request.args?.[0] ?? 0)
          const offset = Number(request.args?.[1] ?? 0)
          if (request.functionName === 'count') {
            throw new Error('global scan should not run')
          }
          if (request.functionName === 'all') {
            expect({ limit, offset }).toEqual({ limit: 1, offset: 7 })
            return [poolTuple(POSITION_POOL, TOKEN_A, TOKEN_B)]
          }
          if (request.functionName === 'positions') {
            expect({ limit, offset }).toEqual({ limit: 1, offset: 7 })
            return [positionTuple(POSITION_POOL)]
          }
          if (request.functionName === 'tokens') {
            return [
              tokenTuple(STABLE_TOKEN, 'USDC', 6),
              tokenTuple(TOKEN_A, 'A'),
              tokenTuple(TOKEN_B, 'B'),
            ]
          }
          if (request.functionName === 'getManyRatesToEthWithCustomConnectors') {
            return stringListArgument(request, 0).map(() => 10n ** 18n)
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      settings: { stableTokenAddress: STABLE_TOKEN },
    })

    const position = await sugar.getPositionByPool(POSITION_POOL)

    expect(position?.pool.lp).toBe(POSITION_POOL)
    expect(reads).not.toContain('count')
    expect(reads.filter((name) => name === 'all')).toHaveLength(1)
  })

  test('invalidates a stale locator and persists the newly verified offset', async () => {
    const deleted: number[] = []
    const stored: number[] = []
    const sugar = new SugarClient(10, {
      account: OWNER,
      poolLocatorStore: {
        get: async () => ({ offset: 7 }),
        set: async (_key, locator) => {
          stored.push(locator.offset)
        },
        delete: async () => {
          deleted.push(7)
        },
      },
      publicClient: stubPublicClient({
        readContract: async (request) => {
          const limit = Number(request.args?.[0] ?? 0)
          const offset = Number(request.args?.[1] ?? 0)
          if (request.functionName === 'count') return 2n
          if (request.functionName === 'all') {
            if (limit === 1 && offset === 7) {
              return [poolTuple(IRRELEVANT_POOL, TOKEN_C, TOKEN_D)]
            }
            if (limit === 1 && offset === 1) {
              return [poolTuple(POSITION_POOL, TOKEN_A, TOKEN_B)]
            }
            if (offset === 0) {
              return [
                poolTuple(IRRELEVANT_POOL, TOKEN_C, TOKEN_D),
                poolTuple(POSITION_POOL, TOKEN_A, TOKEN_B),
              ]
            }
            return []
          }
          if (request.functionName === 'tokens') {
            return [
              tokenTuple(STABLE_TOKEN, 'USDC', 6),
              tokenTuple(TOKEN_A, 'A'),
              tokenTuple(TOKEN_B, 'B'),
            ]
          }
          if (request.functionName === 'getManyRatesToEthWithCustomConnectors') {
            return stringListArgument(request, 0).map(() => 10n ** 18n)
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      settings: {
        stableTokenAddress: STABLE_TOKEN,
        poolPaginationMinSize: 5,
        poolPaginationMaxSize: 5,
        poolPaginationTargetCalls: 1,
      },
    })

    const pool = await sugar.getPoolByAddress(POSITION_POOL)

    expect(pool?.lp).toBe(POSITION_POOL)
    expect(deleted).toEqual([7])
    expect(stored).toEqual([1])
  })

  test("hydrates and prices only the topology required by the owner's positions", async () => {
    const pricedTokenBatches: string[][] = []
    const metadataRequests: string[][] = []
    const positionReads: Array<{ limit: number; offset: number }> = []
    const sugar = new SugarClient(10, {
      account: OWNER,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          const offset = Number(request.args?.[1] ?? 0)
          if (request.functionName === 'count') return 2n
          if (request.functionName === 'positions') {
            positionReads.push({
              limit: Number(request.args?.[0] ?? 0),
              offset,
            })
            return offset === 0 ? [positionTuple(POSITION_POOL)] : []
          }
          if (request.functionName === 'all') {
            return offset === 0
              ? [poolTuple(POSITION_POOL, TOKEN_A, TOKEN_B), poolTuple(IRRELEVANT_POOL, TOKEN_C, TOKEN_D)]
              : []
          }
          if (request.functionName === 'tokens') {
            metadataRequests.push([...stringListArgument(request, 3)])
            return [
              tokenTuple(STABLE_TOKEN, 'USDC', 6),
              tokenTuple(TOKEN_A, 'A'),
              tokenTuple(TOKEN_B, 'B'),
            ]
          }
          if (request.functionName === 'getManyRatesToEthWithCustomConnectors') {
            const addresses = [...stringListArgument(request, 0)]
            pricedTokenBatches.push(addresses)
            return addresses.map(() => 10n ** 18n)
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      settings: {
        stableTokenAddress: STABLE_TOKEN,
        poolPaginationMinSize: 1,
        poolPaginationMaxSize: 5,
        poolPaginationTargetCalls: 1,
      },
    })

    const positions = await sugar.getPositions()
    const targetedPosition = await sugar.getPositionByPool(POSITION_POOL)

    expect(positions).toHaveLength(1)
    expect(targetedPosition?.pool.lp).toBe(POSITION_POOL)
    // Position results are sparse across pool offsets, so pagination must not
    // stop on the empty middle page. It should use the largest safe scan page.
    expect(positionReads.slice(0, -1).map(({ offset }) => offset)).toEqual([0, 5, 10])
    expect(positionReads.at(-1)).toEqual({ limit: 1, offset: 0 })
    expect(positions[0]?.pool.lp).toBe(POSITION_POOL)
    expect(metadataRequests).toHaveLength(2)
    expect(metadataRequests[0]?.map((address) => address.toLowerCase())).toEqual(
      expect.arrayContaining([
        STABLE_TOKEN.toLowerCase(),
        TOKEN_A.toLowerCase(),
        TOKEN_B.toLowerCase(),
      ]),
    )
    expect(metadataRequests[0]).toHaveLength(3)
    expect(metadataRequests[1]).toHaveLength(3)
    const pricedTokens = pricedTokenBatches.flat().map((address) => address.toLowerCase())
    expect(pricedTokens).toEqual(expect.arrayContaining([
      sugar.settings.wrappedNativeTokenAddress.toLowerCase(),
      sugar.settings.stableTokenAddress.toLowerCase(),
      TOKEN_A.toLowerCase(),
      TOKEN_B.toLowerCase(),
    ]))
    expect(pricedTokens).toHaveLength(4)
    expect(pricedTokens).not.toContain(TOKEN_C.toLowerCase())
    expect(pricedTokens).not.toContain(TOKEN_D.toLowerCase())
  })
})
