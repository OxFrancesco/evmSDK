import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, parseAbi, type Address } from 'viem'
import { SugarClient } from './client'
import { stubPublicClient } from './test-support'
import type { LiquidityPool, Token } from './types'

const account: Address = '0x1111111111111111111111111111111111111111'
const voter: Address = '0x2222222222222222222222222222222222222222'
const votingEscrow: Address = '0x3333333333333333333333333333333333333333'
const governanceToken: Address = '0x4444444444444444444444444444444444444444'
const distributor: Address = '0x5555555555555555555555555555555555555555'
const pool: Address = '0x6666666666666666666666666666666666666666'
const rewardToken: Address = '0x8888888888888888888888888888888888888888'
const secondRewardToken: Address = '0x9999999999999999999999999999999999999999'
const feeVotingReward = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const incentiveVotingReward = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

describe('native veNFT management', () => {
  test('lists owned veNFTs through the typed client surface', async () => {
    const sugar = new SugarClient(10, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'byAccount') {
            return [[
              42n,
              account,
              18,
              1_000n,
              900n,
              800n,
              25n,
              1_900_000_000n,
              1_800_000_000n,
              [[pool, 750n]],
              governanceToken,
              false,
              7n,
              0n,
            ]]
          }
          if (request.functionName === 'escrowType') return 0
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    await expect(sugar.getVeNfts()).resolves.toEqual([{
      chainId: 10,
      chainName: 'OP',
      id: 42n,
      owner: account,
      decimals: 18,
      lockedAmount: 1_000n,
      votingPower: 900n,
      governancePower: 800n,
      claimableRebase: 25n,
      expiresAt: 1_900_000_000,
      votedAt: 1_800_000_000,
      votes: [{ pool, weight: 750n }],
      governanceToken,
      permanent: false,
      delegateId: 7n,
      managedId: 0n,
      state: 'normal',
    }])
  })

  test('reads a managed veNFT by id even when another account owns it', async () => {
    const manager: Address = '0x1212121212121212121212121212121212121212'
    const sugar = new SugarClient(8453, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'byId') {
            return [99n, manager, 18, 5_000n, 5_000n, 5_000n, 0n, 0n, 0n, [], governanceToken, true, 0n, 0n]
          }
          if (request.functionName === 'escrowType') return 2
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    const managed = await sugar.getVeNft(99n)
    expect(managed).toEqual(expect.objectContaining({
      id: 99n,
      owner: manager,
      permanent: true,
      state: 'managed',
    }))
  })

  test('rejects veNFT operations locally on leaf chains', async () => {
    let rpcCalls = 0
    const sugar = new SugarClient(1135, {
      account,
      publicClient: stubPublicClient({
        readContract: async () => {
          rpcCalls += 1
          return []
        },
      }),
    })

    await expect(sugar.getVeNfts()).rejects.toThrow('veNFTs are not supported on Lisk')
    await expect(sugar.getVeNftRewards(42n, pool)).rejects.toThrow('veNFTs are not supported on Lisk')
    expect(rpcCalls).toBe(0)
  })

  test('creates a veNFT with governance-token approval first', async () => {
    const sugar = new SugarClient(8453, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'allowance') return 0n
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    const transactions = await sugar.createVeNft(1_000n, 4 * 7 * 86_400)
    expect(transactions.map((transaction) => transaction.to)).toEqual([
      governanceToken,
      votingEscrow,
    ])
    expect(decodeFunctionData({
      abi: parseAbi(['function approve(address spender,uint256 amount)']),
      data: transactions[0].data,
    }).args).toEqual([votingEscrow, 1_000n])
    expect(decodeFunctionData({
      abi: parseAbi(['function createLock(uint256 value,uint256 lockDuration)']),
      data: transactions[1].data,
    }).args).toEqual([1_000n, 2_419_200n])
  })

  test('increases a veNFT lock without a redundant token approval', async () => {
    const sugar = new SugarClient(10, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'allowance') return 500n
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    const transactions = await sugar.increaseVeNftAmount(42n, 500n)
    expect(transactions).toHaveLength(1)
    expect(decodeFunctionData({
      abi: parseAbi(['function increaseAmount(uint256 tokenId,uint256 value)']),
      data: transactions[0].data,
    }).args).toEqual([42n, 500n])
  })

  test('builds the existing veNFT lifecycle operations', async () => {
    const sugar = new SugarClient(10, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })
    const lifecycleAbi = parseAbi([
      'function increaseUnlockTime(uint256 tokenId,uint256 lockDuration)',
      'function withdraw(uint256 tokenId)',
      'function merge(uint256 from,uint256 to)',
      'function split(uint256 from,uint256 amount) returns (uint256,uint256)',
      'function lockPermanent(uint256 tokenId)',
      'function unlockPermanent(uint256 tokenId)',
      'function delegate(uint256 delegator,uint256 delegatee)',
    ])
    const transactions = await Promise.all([
      sugar.extendVeNftLock(42n, 8 * 7 * 86_400),
      sugar.withdrawVeNft(42n),
      sugar.mergeVeNfts(41n, 42n),
      sugar.splitVeNft(42n, 250n),
      sugar.setVeNftPermanent(42n, true),
      sugar.setVeNftPermanent(42n, false),
      sugar.delegateVeNft(42n, 7n),
    ])

    expect(transactions.map(([transaction]) => decodeFunctionData({
      abi: lifecycleAbi,
      data: transaction.data,
    }))).toEqual([
      { functionName: 'increaseUnlockTime', args: [42n, 4_838_400n] },
      { functionName: 'withdraw', args: [42n] },
      { functionName: 'merge', args: [41n, 42n] },
      { functionName: 'split', args: [42n, 250n] },
      { functionName: 'lockPermanent', args: [42n] },
      { functionName: 'unlockPermanent', args: [42n] },
      { functionName: 'delegate', args: [42n, 7n] },
    ])
    expect(transactions.flat().every((transaction) => transaction.to === votingEscrow)).toBe(true)
  })

  test('builds voting and managed-veNFT operations through Voter', async () => {
    const sugar = new SugarClient(8453, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })
    const otherPool: Address = '0x7777777777777777777777777777777777777777'
    const voterAbi = parseAbi([
      'function vote(uint256 tokenId,address[] pools,uint256[] weights)',
      'function reset(uint256 tokenId)',
      'function poke(uint256 tokenId)',
      'function depositManaged(uint256 tokenId,uint256 managedTokenId)',
      'function withdrawManaged(uint256 tokenId)',
    ])
    const transactions = await Promise.all([
      sugar.voteVeNft(42n, [{ pool, weight: 3n }, { pool: otherPool, weight: 1n }]),
      sugar.resetVeNftVotes(42n),
      sugar.pokeVeNftVotes(42n),
      sugar.depositVeNftIntoManaged(42n, 99n),
      sugar.withdrawVeNftFromManaged(42n),
    ])

    expect(transactions.map(([transaction]) => decodeFunctionData({
      abi: voterAbi,
      data: transaction.data,
    }))).toEqual([
      { functionName: 'vote', args: [42n, [pool, otherPool], [3n, 1n]] },
      { functionName: 'reset', args: [42n] },
      { functionName: 'poke', args: [42n] },
      { functionName: 'depositManaged', args: [42n, 99n] },
      { functionName: 'withdrawManaged', args: [42n] },
    ])
    expect(transactions.flat().every((transaction) => transaction.to === voter)).toBe(true)
    await expect(sugar.voteVeNft(42n, [])).rejects.toThrow('at least one pool vote')
  })

  test('discovers and batch-claims veNFT fees and incentives', async () => {
    const rawRewards = [
      [42n, pool, 125n, rewardToken, feeVotingReward, incentiveVotingReward],
      [42n, pool, 250n, secondRewardToken, feeVotingReward, incentiveVotingReward],
    ]
    const sugar = new SugarClient(10, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'MAX_REWARDS') return 50n
          if (request.functionName === 'rewards') return rawRewards
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    await expect(sugar.getVeNftRewards(42n)).resolves.toEqual([
      {
        veNftId: 42n,
        pool,
        amount: 125n,
        token: rewardToken,
        feeVotingReward,
        incentiveVotingReward,
      },
      {
        veNftId: 42n,
        pool,
        amount: 250n,
        token: secondRewardToken,
        feeVotingReward,
        incentiveVotingReward,
      },
    ])

    const transactions = await sugar.claimVeNftRewards(42n)
    const claimAbi = parseAbi([
      'function claimBribes(address[] rewards,address[][] tokens,uint256 tokenId)',
      'function claimFees(address[] rewards,address[][] tokens,uint256 tokenId)',
    ])
    expect(transactions.map((transaction) => decodeFunctionData({
      abi: claimAbi,
      data: transaction.data,
    }))).toEqual([
      {
        functionName: 'claimBribes',
        args: [[incentiveVotingReward], [[rewardToken, secondRewardToken]], 42n],
      },
      {
        functionName: 'claimFees',
        args: [[feeVotingReward], [[rewardToken, secondRewardToken]], 42n],
      },
    ])
  })

  test('reads and claims veNFT rebases singly or in a batch', async () => {
    const sugar = new SugarClient(8453, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'voter') return voter
          if (request.functionName === 've') return votingEscrow
          if (request.functionName === 'token') return governanceToken
          if (request.functionName === 'dist') return distributor
          if (request.functionName === 'claimable') return 321n
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    await expect(sugar.getVeNftRebase(42n)).resolves.toBe(321n)
    const [single, batch] = await Promise.all([
      sugar.claimVeNftRebase(42n),
      sugar.claimVeNftRebases([42n, 43n]),
    ])
    const rebaseAbi = parseAbi([
      'function claim(uint256 tokenId) returns (uint256)',
      'function claimMany(uint256[] tokenIds) returns (bool)',
    ])
    expect([single[0], batch[0]].map((transaction) => decodeFunctionData({
      abi: rebaseAbi,
      data: transaction.data,
    }))).toEqual([
      { functionName: 'claim', args: [42n] },
      { functionName: 'claimMany', args: [[42n, 43n]] },
    ])
  })

  test('adds a pool voting incentive through the chain-specific reward contract', async () => {
    const gauge = getAddress('0xcccccccccccccccccccccccccccccccccccccccc')
    const sugar = new SugarClient(1135, {
      account,
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'gaugeToFees') return feeVotingReward
          if (request.functionName === 'gaugeToIncentive') return incentiveVotingReward
          if (request.functionName === 'allowance') return 0n
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })
    // SAFETY: getPoolRewardContracts and incentivizePool read only the pool's
    // chain identity, symbol, and gauge; the remaining LiquidityPool fields are
    // never touched by this test.
    const targetPool = {
      chainId: 1135,
      chainName: 'Lisk',
      symbol: 'vAMM-A/B',
      gauge,
    } as LiquidityPool
    const incentiveToken: Token = {
      chainId: 1135,
      chainName: 'Lisk',
      tokenAddress: rewardToken,
      symbol: 'RWD',
      decimals: 18,
      listed: true,
      emerging: false,
    }

    await expect(sugar.getPoolRewardContracts(targetPool)).resolves.toEqual({
      gauge,
      feeVotingReward,
      incentiveVotingReward,
    })
    const transactions = await sugar.incentivizePool(targetPool, incentiveToken, 1_000n)
    expect(transactions.map((transaction) => transaction.to)).toEqual([
      rewardToken,
      incentiveVotingReward,
    ])
    expect(decodeFunctionData({
      abi: parseAbi(['function notifyRewardAmount(address token,uint256 amount)']),
      data: transactions[1].data,
    }).args).toEqual([rewardToken, 1_000n])
  })
})
