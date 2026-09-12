import * as Cache from 'effect/Cache'
import * as Effect from 'effect/Effect'
import type { Address } from 'viem'
import { abis } from './abis'
import { addressKey, normalizeAddress, tokenContractAddress, tupleValues } from './helpers'
import { makeReadCache } from './internal/caches'
import type { SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { veNftFromTuple, veNftRewardFromTuple } from './models'
import { approveAddressIfNeeded } from './transactions'
import {
  ADDRESS_ZERO,
  type LiquidityPool,
  type Token,
  type UnsignedTransaction,
  type VeNftContracts,
  type VeNftVote,
} from './types'

export function supportsVeNfts(ctx: SugarContext): boolean {
  return ctx.settings.veSugarContractAddress !== undefined
}

export function requireVeSugar(ctx: SugarContext): Address {
  if (!ctx.settings.veSugarContractAddress) {
    throw new Error(`veNFTs are not supported on ${ctx.settings.chainName}`)
  }
  return ctx.settings.veSugarContractAddress
}

export const getVeNftContracts = Effect.fn('Sugar.VeNfts.getVeNftContracts')(function* (
  ctx: SugarContext,
) {
  const veSugar = requireVeSugar(ctx)
  const cache = ctx.veNftContractsCache ??= yield* makeReadCache((_key: 'contracts') =>
    Effect.all([
      ctx.read<Address>(veSugar, abis.veSugar, 'voter'),
      ctx.read<Address>(veSugar, abis.veSugar, 've'),
      ctx.read<Address>(veSugar, abis.veSugar, 'token'),
      ctx.read<Address>(veSugar, abis.veSugar, 'dist'),
    ], { concurrency: 'unbounded' }).pipe(
      Effect.map(([voter, votingEscrow, governanceToken, rewardsDistributor]): VeNftContracts => ({
        veSugar,
        voter: normalizeAddress(voter),
        votingEscrow: normalizeAddress(votingEscrow),
        governanceToken: normalizeAddress(governanceToken),
        rewardsDistributor: normalizeAddress(rewardsDistributor),
      })),
    ),
  )
  return yield* Cache.get(cache, 'contracts')
})

export const getVeNfts = Effect.fn('Sugar.VeNfts.getVeNfts')(function* (
  ctx: SugarContext,
  owner?: Address,
) {
  const veSugar = requireVeSugar(ctx)
  if (!owner) throw new Error('Owner address is required to list veNFTs')
  const [contracts, raw] = yield* Effect.all([
    clientCall(() => ctx.client.getVeNftContracts()),
    ctx.read<unknown[]>(veSugar, abis.veSugar, 'byAccount', [normalizeAddress(owner)]),
  ], { concurrency: 'unbounded' })
  const states = yield* ctx.rpc.forEachRead(
    'escrowType',
    raw,
    (item, _index, signal) => ctx.readTask<number>(
      contracts.votingEscrow,
      abis.votingEscrow,
      'escrowType',
      [BigInt(String(tupleValues(item)[0]))],
    )(signal),
    ctx.settings.requestConcurrency,
  )
  return raw.map((item, index) => veNftFromTuple(item, states[index], ctx.settings))
})

export const getVeNft = Effect.fn('Sugar.VeNfts.getVeNft')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  const veSugar = requireVeSugar(ctx)
  const [contracts, raw] = yield* Effect.all([
    clientCall(() => ctx.client.getVeNftContracts()),
    ctx.read<unknown>(veSugar, abis.veSugar, 'byId', [tokenId]),
  ], { concurrency: 'unbounded' })
  const values = tupleValues(raw)
  if (BigInt(String(values[0])) === 0n || normalizeAddress(String(values[1])) === ADDRESS_ZERO) {
    return undefined
  }
  const state = yield* ctx.read<number>(
    contracts.votingEscrow,
    abis.votingEscrow,
    'escrowType',
    [tokenId],
  )
  return veNftFromTuple(raw, state, ctx.settings)
})

export const getVeNftRewards = Effect.fn('Sugar.VeNfts.getVeNftRewards')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  pool?: Address,
) {
  assertVeNftId(tokenId)
  requireVeSugar(ctx)
  const rewardsSugar = ctx.settings.sugarRewardsContractAddress
  if (pool) {
    const raw = yield* ctx.read<unknown[]>(
      rewardsSugar,
      abis.sugarRewards,
      'rewardsByAddress',
      [tokenId, normalizeAddress(pool)],
    )
    return raw.map(veNftRewardFromTuple)
  }
  const rawLimit = yield* ctx.read<bigint>(rewardsSugar, abis.sugarRewards, 'MAX_REWARDS')
  const limit = Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid RewardsSugar page limit')
  const results: unknown[] = []
  for (let offset = 0; offset < 10_000; offset += limit) {
    const page = yield* ctx.read<unknown[]>(
      rewardsSugar,
      abis.sugarRewards,
      'rewards',
      [BigInt(limit), BigInt(offset), tokenId],
    )
    results.push(...page)
    if (page.length < limit) return results.map(veNftRewardFromTuple)
  }
  throw new Error('veNFT reward pagination exceeded 10,000 entries')
})

export const createVeNft = Effect.fn('Sugar.VeNfts.createVeNft')(function* (
  ctx: SugarContext,
  amount: bigint,
  lockDurationSeconds: number,
) {
  if (amount <= 0n) throw new Error('veNFT amount must be positive')
  if (!Number.isSafeInteger(lockDurationSeconds) || lockDurationSeconds <= 0) {
    throw new Error('veNFT lock duration must be a positive integer number of seconds')
  }
  const contracts = yield* clientCall(() => ctx.client.getVeNftContracts())
  const approval = yield* approveAddressIfNeeded(
    ctx,
    contracts.governanceToken,
    contracts.votingEscrow,
    amount,
  )
  const create = ctx.tx(
    contracts.votingEscrow,
    ctx.encode(abis.votingEscrow, 'createLock', [amount, BigInt(lockDurationSeconds)]),
  )
  return [approval, create].filter((transaction): transaction is UnsignedTransaction => transaction !== undefined)
})

export const increaseVeNftAmount = Effect.fn('Sugar.VeNfts.increaseVeNftAmount')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  amount: bigint,
) {
  if (tokenId <= 0n) throw new Error('veNFT token id must be positive')
  if (amount <= 0n) throw new Error('veNFT amount must be positive')
  const contracts = yield* clientCall(() => ctx.client.getVeNftContracts())
  const approval = yield* approveAddressIfNeeded(
    ctx,
    contracts.governanceToken,
    contracts.votingEscrow,
    amount,
  )
  const increase = ctx.tx(
    contracts.votingEscrow,
    ctx.encode(abis.votingEscrow, 'increaseAmount', [tokenId, amount]),
  )
  return [approval, increase].filter((transaction): transaction is UnsignedTransaction => transaction !== undefined)
})

function assertVeNftId(tokenId: bigint, label = 'veNFT token id'): void {
  if (tokenId <= 0n) throw new Error(`${label} must be positive`)
}

const buildVeNftCall = Effect.fn('Sugar.VeNfts.buildVeNftCall')(function* (
  ctx: SugarContext,
  functionName: string,
  args: readonly unknown[],
) {
  const { votingEscrow } = yield* clientCall(() => ctx.client.getVeNftContracts())
  return [ctx.tx(votingEscrow, ctx.encode(abis.votingEscrow, functionName, args))]
})

export const extendVeNftLock = Effect.fn('Sugar.VeNfts.extendVeNftLock')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  lockDurationSeconds: number,
) {
  assertVeNftId(tokenId)
  if (!Number.isSafeInteger(lockDurationSeconds) || lockDurationSeconds <= 0) {
    throw new Error('veNFT lock duration must be a positive integer number of seconds')
  }
  return yield* buildVeNftCall(ctx, 'increaseUnlockTime', [tokenId, BigInt(lockDurationSeconds)])
})

export const withdrawVeNft = Effect.fn('Sugar.VeNfts.withdrawVeNft')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  return yield* buildVeNftCall(ctx, 'withdraw', [tokenId])
})

export const mergeVeNfts = Effect.fn('Sugar.VeNfts.mergeVeNfts')(function* (
  ctx: SugarContext,
  fromTokenId: bigint,
  intoTokenId: bigint,
) {
  assertVeNftId(fromTokenId, 'source veNFT token id')
  assertVeNftId(intoTokenId, 'destination veNFT token id')
  if (fromTokenId === intoTokenId) throw new Error('source and destination veNFTs must differ')
  return yield* buildVeNftCall(ctx, 'merge', [fromTokenId, intoTokenId])
})

export const splitVeNft = Effect.fn('Sugar.VeNfts.splitVeNft')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  amount: bigint,
) {
  assertVeNftId(tokenId)
  if (amount <= 0n) throw new Error('veNFT split amount must be positive')
  return yield* buildVeNftCall(ctx, 'split', [tokenId, amount])
})

export const setVeNftPermanent = Effect.fn('Sugar.VeNfts.setVeNftPermanent')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  permanent: boolean,
) {
  assertVeNftId(tokenId)
  return yield* buildVeNftCall(ctx, permanent ? 'lockPermanent' : 'unlockPermanent', [tokenId])
})

export const delegateVeNft = Effect.fn('Sugar.VeNfts.delegateVeNft')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  delegateTokenId: bigint,
) {
  assertVeNftId(tokenId)
  if (delegateTokenId < 0n) throw new Error('delegate veNFT token id must not be negative')
  return yield* buildVeNftCall(ctx, 'delegate', [tokenId, delegateTokenId])
})

const buildVoterCall = Effect.fn('Sugar.VeNfts.buildVoterCall')(function* (
  ctx: SugarContext,
  functionName: string,
  args: readonly unknown[],
) {
  const { voter } = yield* clientCall(() => ctx.client.getVeNftContracts())
  return [ctx.tx(voter, ctx.encode(abis.voter, functionName, args))]
})

export const voteVeNft = Effect.fn('Sugar.VeNfts.voteVeNft')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  votes: readonly VeNftVote[],
) {
  assertVeNftId(tokenId)
  if (votes.length === 0) throw new Error('veNFT vote requires at least one pool vote')
  const pools = votes.map(({ pool }) => normalizeAddress(pool))
  if (new Set(pools.map(addressKey)).size !== pools.length) {
    throw new Error('veNFT vote pools must be unique')
  }
  if (votes.some(({ weight }) => weight <= 0n)) {
    throw new Error('veNFT vote weights must be positive')
  }
  return yield* buildVoterCall(ctx, 'vote', [tokenId, pools, votes.map(({ weight }) => weight)])
})

export const resetVeNftVotes = Effect.fn('Sugar.VeNfts.resetVeNftVotes')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  return yield* buildVoterCall(ctx, 'reset', [tokenId])
})

export const pokeVeNftVotes = Effect.fn('Sugar.VeNfts.pokeVeNftVotes')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  return yield* buildVoterCall(ctx, 'poke', [tokenId])
})

export const depositVeNftIntoManaged = Effect.fn('Sugar.VeNfts.depositVeNftIntoManaged')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  managedTokenId: bigint,
) {
  assertVeNftId(tokenId)
  assertVeNftId(managedTokenId, 'managed veNFT token id')
  if (tokenId === managedTokenId) throw new Error('veNFT and managed veNFT token ids must differ')
  return yield* buildVoterCall(ctx, 'depositManaged', [tokenId, managedTokenId])
})

export const withdrawVeNftFromManaged = Effect.fn('Sugar.VeNfts.withdrawVeNftFromManaged')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  return yield* buildVoterCall(ctx, 'withdrawManaged', [tokenId])
})

export const claimVeNftRewards = Effect.fn('Sugar.VeNfts.claimVeNftRewards')(function* (
  ctx: SugarContext,
  tokenId: bigint,
  pool?: Address,
) {
  assertVeNftId(tokenId)
  const allRewards = yield* clientCall(() => ctx.client.getVeNftRewards(tokenId, pool))
  const rewards = allRewards.filter(({ amount }) => amount > 0n)
  const group = (field: 'feeVotingReward' | 'incentiveVotingReward') => {
    const grouped = new Map<string, { contract: Address; tokens: Map<string, Address> }>()
    for (const reward of rewards) {
      const contract = reward[field]
      if (contract === ADDRESS_ZERO) continue
      const key = addressKey(contract)
      const entry = grouped.get(key) ?? { contract, tokens: new Map<string, Address>() }
      entry.tokens.set(addressKey(reward.token), reward.token)
      grouped.set(key, entry)
    }
    const entries = [...grouped.values()]
    return {
      contracts: entries.map((entry) => entry.contract),
      tokens: entries.map((entry) => [...entry.tokens.values()]),
    }
  }
  const incentives = group('incentiveVotingReward')
  const fees = group('feeVotingReward')
  const { voter } = yield* clientCall(() => ctx.client.getVeNftContracts())
  const transactions: UnsignedTransaction[] = []
  if (incentives.contracts.length > 0) {
    transactions.push(ctx.tx(voter, ctx.encode(abis.voter, 'claimBribes', [
      incentives.contracts,
      incentives.tokens,
      tokenId,
    ])))
  }
  if (fees.contracts.length > 0) {
    transactions.push(ctx.tx(voter, ctx.encode(abis.voter, 'claimFees', [
      fees.contracts,
      fees.tokens,
      tokenId,
    ])))
  }
  return transactions
})

export const getVeNftRebase = Effect.fn('Sugar.VeNfts.getVeNftRebase')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  const { rewardsDistributor } = yield* clientCall(() => ctx.client.getVeNftContracts())
  return yield* ctx.read<bigint>(rewardsDistributor, abis.rewardsDistributor, 'claimable', [tokenId])
})

export const claimVeNftRebase = Effect.fn('Sugar.VeNfts.claimVeNftRebase')(function* (
  ctx: SugarContext,
  tokenId: bigint,
) {
  assertVeNftId(tokenId)
  const { rewardsDistributor } = yield* clientCall(() => ctx.client.getVeNftContracts())
  return [ctx.tx(
    rewardsDistributor,
    ctx.encode(abis.rewardsDistributor, 'claim', [tokenId]),
  )]
})

export const claimVeNftRebases = Effect.fn('Sugar.VeNfts.claimVeNftRebases')(function* (
  ctx: SugarContext,
  tokenIds: readonly bigint[],
) {
  if (tokenIds.length === 0) throw new Error('veNFT rebase claim requires at least one token id')
  tokenIds.forEach((tokenId) => assertVeNftId(tokenId))
  if (new Set(tokenIds).size !== tokenIds.length) {
    throw new Error('veNFT rebase token ids must be unique')
  }
  const { rewardsDistributor } = yield* clientCall(() => ctx.client.getVeNftContracts())
  return [ctx.tx(
    rewardsDistributor,
    ctx.encode(abis.rewardsDistributor, 'claimMany', [[...tokenIds]]),
  )]
})

export const getPoolRewardContracts = Effect.fn('Sugar.VeNfts.getPoolRewardContracts')(function* (
  ctx: SugarContext,
  pool: LiquidityPool,
) {
  if (pool.chainId !== ctx.settings.chainId) {
    throw new Error(`Pool chain ${pool.chainId} does not match client chain ${ctx.settings.chainId}`)
  }
  const gauge = normalizeAddress(pool.gauge)
  if (gauge === ADDRESS_ZERO) throw new Error(`pool ${pool.symbol} has no gauge`)
  const incentiveFunction = ctx.client.supportsVeNfts() ? 'gaugeToBribe' : 'gaugeToIncentive'
  const [feeVotingReward, incentiveVotingReward] = yield* Effect.all([
    ctx.read<Address>(ctx.settings.voterContractAddress, abis.voter, 'gaugeToFees', [gauge]),
    ctx.read<Address>(ctx.settings.voterContractAddress, abis.voter, incentiveFunction, [gauge]),
  ], { concurrency: 'unbounded' })
  return {
    gauge,
    feeVotingReward: normalizeAddress(feeVotingReward),
    incentiveVotingReward: normalizeAddress(incentiveVotingReward),
  }
})

export const incentivizePool = Effect.fn('Sugar.VeNfts.incentivizePool')(function* (
  ctx: SugarContext,
  pool: LiquidityPool,
  token: Token,
  amount: bigint,
) {
  if (token.chainId !== ctx.settings.chainId) {
    throw new Error(`Reward token chain ${token.chainId} does not match client chain ${ctx.settings.chainId}`)
  }
  if (amount <= 0n) throw new Error('Pool incentive amount must be positive')
  const { incentiveVotingReward } = yield* clientCall(() => ctx.client.getPoolRewardContracts(pool))
  if (incentiveVotingReward === ADDRESS_ZERO) {
    throw new Error(`pool ${pool.symbol} has no incentive voting reward contract`)
  }
  const tokenAddress = tokenContractAddress(token)
  const approval = yield* approveAddressIfNeeded(ctx, tokenAddress, incentiveVotingReward, amount)
  const notify = ctx.tx(
    incentiveVotingReward,
    ctx.encode(abis.votingReward, 'notifyRewardAmount', [tokenAddress, amount]),
  )
  return [approval, notify].filter((transaction): transaction is UnsignedTransaction => transaction !== undefined)
})
