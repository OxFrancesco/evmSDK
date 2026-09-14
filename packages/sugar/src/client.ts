// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import {
  createPublicClient,
  encodeFunctionData,
  http,
  pad,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { abis } from './abis'
import { getChainSettings } from './config'
import { normalizeAddress } from './helpers'
import type { ReadArgs, SugarContext } from './internal/context'
import { runSugar } from './internal/interop'
import { invalidateSugarCaches, SugarCaches, sugarCachesLayer } from './internal/caches'
import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import { getPoolCount, getPoolPaginator, pageSize } from './internal/pagination'
import {
  RpcReader,
  rpcReaderLayer,
  type RpcReadExecutor,
  type RpcReadTask,
} from './internal/rpc-executor'
import * as poolsApi from './pools'
import * as positionsApi from './positions'
import * as pricesApi from './prices'
import * as quotesApi from './quotes'
import * as tokensApi from './tokens'
import * as transactionsApi from './transactions'
import * as venftsApi from './venfts'
import {
  XCHAIN_GAS_LIMIT_UPPERBOUND,
  type ChainId,
  type ChainSettings,
  type DepositQuote,
  type LiquidityPool,
  type LiquidityPoolEpoch,
  type LiquidityPoolForSwap,
  type PathHop,
  type PoolRewardContracts,
  type Position,
  type Price,
  type Quote,
  type SugarClientOptions,
  type Token,
  type UnsignedTransaction,
  type VeNft,
  type VeNftContracts,
  type VeNftReward,
  type VeNftVote,
  type Withdrawal,
} from './types'

/**
 * Thin promise facade over the Effect-based domain modules (tokens, prices,
 * pools, venfts, positions, quotes, transactions). All state lives in one
 * SugarContext built by the constructor, so caching semantics are shared
 * across domains exactly as before the extraction. Each method runs its
 * domain effect through `runSugar`, which preserves the identity of thrown
 * SugarRpcError and precondition errors for promise consumers.
 */
export class SugarClient {
  readonly settings: ChainSettings
  readonly account?: Address
  readonly publicClient: PublicClient
  // Shared with ctx.rpc; kept on the instance so tests and subclasses can
  // observe or patch the executor. (protected: private would trip the
  // stricter noUnusedLocals config some workspace consumers compile with.)
  protected readonly rpc: RpcReadExecutor
  private readonly ctx: SugarContext

  constructor(chainId: ChainId | number, options: SugarClientOptions = {}) {
    this.settings = getChainSettings(chainId, { env: options.env, overrides: { ...options.settings, rpcUrl: options.rpcUrl ?? options.settings?.rpcUrl } })
    this.account = options.account ? normalizeAddress(options.account) : undefined
    const onRpcEvent = options.onRpcEvent
    const cacheEntry = options.cacheStore?.cachesFor(this.settings.chainId, this.settings.rpcUrl, JSON.stringify(this.settings))
      ?? { priceRateCache: new Map() }
    // Both services are plain in-memory handles with no finalizers, so the build scope closes immediately.
    const services = Effect.runSync(Effect.scoped(Layer.build(Layer.mergeAll(
      rpcReaderLayer(options.rpcPolicy, onRpcEvent),
      sugarCachesLayer(cacheEntry, {
        tokens: tokensApi.tokenCatalogLookup,
        rawPools: poolsApi.rawPoolsLookup,
        pools: poolsApi.poolsLookup,
        permit2Address: transactionsApi.permit2AddressLookup,
        veNftContracts: venftsApi.veNftContractsLookup,
        poolLocator: poolsApi.lookupPoolLocator,
      }, () => this.ctx),
    ))))
    const rpc = Context.get(services, RpcReader)
    const readCaches = Context.get(services, SugarCaches)
    this.rpc = rpc
    this.publicClient = options.publicClient ?? createPublicClient({
      // Several upstream public RPCs (notably Lisk dRPC) reject JSON-RPC batch
      // bodies with HTTP 500. Contract-level Multicall3 is used where batching
      // matters, while the base transport stays universally compatible.
      transport: options.transport ?? http(this.settings.rpcUrl, {
        retryCount: 0,
        timeout: Math.min(30_000, rpc.policy.deadlineMs),
      }),
      batch: { multicall: true },
    })

    const { settings, account, publicClient } = this
    const signer = (): Address => {
      if (!account) throw new Error('This operation requires an account address')
      return account
    }
    const readTask = <T>(address: Address, abi: Abi, functionName: string, args?: ReadArgs): RpcReadTask<T> =>
      // SAFETY: viem cannot statically type a dynamic read over a JSON ABI;
      // each caller pins the concrete result type it decodes.
      () => publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>
    this.ctx = {
      client: this,
      settings,
      account,
      publicClient,
      rpc,
      caches: cacheEntry,
      readCaches,
      poolLocatorStore: options.poolLocatorStore,
      readTask,
      read: (address, abi, functionName, args, deadline) =>
        rpc.read(functionName, readTask(address, abi, functionName, args), deadline),
      signer,
      tx: (to: Address, data: Hex, value = 0n): UnsignedTransaction => ({ from: signer(), to, data, value }),
      encode: (abi: Abi, functionName: string, args: readonly unknown[] = []): Hex =>
        // SAFETY: viem cannot statically type dynamic function encoding over
        // a JSON ABI; the ABI entries pin the argument shapes at runtime.
        encodeFunctionData({ abi, functionName, args } as never),
      emitRpcEvent: (event) => {
        try {
          onRpcEvent?.(event)
        } catch {
          // Observability must never alter an SDK result.
        }
      },
    }
  }

  invalidate(): Promise<void> {
    return runSugar(Effect.all([
      invalidateSugarCaches(this.ctx.caches),
      Cache.invalidateAll(this.ctx.readCaches.resolvedPoolLocators),
    ]).pipe(Effect.asVoid))
  }

  buildTransaction(to: Address, data: Hex, value = 0n): UnsignedTransaction {
    return this.ctx.tx(to, data, value)
  }

  calculateOptimalBatchSize(poolCount: number): number {
    return pageSize(this.ctx, poolCount)
  }

  getPoolPaginator(poolCount: number): Array<{ offset: number; limit: number }> {
    return getPoolPaginator(this.ctx, poolCount)
  }

  getPoolCount(): Promise<number> {
    return runSugar(getPoolCount(this.ctx))
  }

  getBridgeFee(domain: number): Promise<bigint> {
    return runSugar(transactionsApi.getBridgeFee(this.ctx, domain))
  }

  getXchainFee(destinationDomain: number): Promise<bigint> {
    return runSugar(this.ctx.read(this.settings.interchainRouterContractAddress, abis.interchainRouter, 'quoteGasForCommitReveal', [destinationDomain, XCHAIN_GAS_LIMIT_UPPERBOUND]))
  }

  getRemoteInterchainAccount(destinationDomain: number): Promise<Address> {
    return runSugar(this.ctx.read(this.settings.interchainRouterContractAddress, abis.interchainRouter, 'getRemoteInterchainAccount', [
      destinationDomain,
      this.settings.swapperContractAddress,
      pad(this.ctx.signer(), { size: 32 }),
    ]))
  }

  getIcaHook(): Promise<Address> {
    return runSugar(this.ctx.read(this.settings.interchainRouterContractAddress, abis.interchainRouter, 'hook'))
  }

  // --- tokens ---

  balanceOf(tokenAddress: Address, ownerAddress: Address): Promise<bigint> {
    return runSugar(tokensApi.balanceOf(this.ctx, tokenAddress, ownerAddress))
  }

  getTokenBalance(token: Token, ownerAddress = this.account): Promise<bigint> {
    return runSugar(tokensApi.getTokenBalance(this.ctx, token, ownerAddress))
  }

  getUserIcaBalance(userIca: Address): Promise<bigint> {
    return runSugar(tokensApi.getUserIcaBalance(this.ctx, userIca))
  }

  getAllTokens(listedOnly = false): Promise<Token[]> {
    return runSugar(tokensApi.getAllTokens(this.ctx, listedOnly))
  }

  getToken(reference: string | bigint | number): Promise<Token | undefined> {
    return runSugar(tokensApi.getToken(this.ctx, reference))
  }

  getBridgeToken(): Promise<Token> {
    return runSugar(tokensApi.getBridgeToken(this.ctx))
  }

  // --- prices ---

  getPriceRequestTokens(tokens: Token[]): Token[] {
    return pricesApi.getPriceRequestTokens(tokens)
  }

  getPriceConnectors(): Address[] {
    return pricesApi.getPriceConnectors(this.ctx)
  }

  getPrices(tokens: Token[]): Promise<Price[]> {
    return runSugar(pricesApi.getPrices(this.ctx, tokens))
  }

  // --- pools ---

  getRawPools(forSwaps = false): Promise<unknown[]> {
    return runSugar(poolsApi.getRawPools(this.ctx, forSwaps))
  }

  async getPools(): Promise<LiquidityPool[]>
  async getPools(forSwaps: false): Promise<LiquidityPool[]>
  async getPools(forSwaps: true): Promise<LiquidityPoolForSwap[]>
  async getPools(forSwaps = false): Promise<LiquidityPool[] | LiquidityPoolForSwap[]> {
    return runSugar(poolsApi.getPools(this.ctx, forSwaps))
  }

  getPoolsForSwaps(): Promise<LiquidityPoolForSwap[]> {
    return runSugar(poolsApi.getPoolsForSwaps(this.ctx))
  }

  getPoolByAddress(address: Address | string): Promise<LiquidityPool | undefined> {
    return runSugar(poolsApi.getPoolByAddress(this.ctx, address))
  }

  getPoolEpochs(lp: Address | string, offset = 0, limit = 10): Promise<LiquidityPoolEpoch[]> {
    return runSugar(poolsApi.getPoolEpochs(this.ctx, lp, offset, limit))
  }

  getLatestPoolEpochs(): Promise<LiquidityPoolEpoch[]> {
    return runSugar(poolsApi.getLatestPoolEpochs(this.ctx))
  }

  // --- veNFTs & voting rewards ---

  supportsVeNfts(): boolean {
    return venftsApi.supportsVeNfts(this.ctx)
  }

  getVeNftContracts(): Promise<VeNftContracts> {
    return runSugar(venftsApi.getVeNftContracts(this.ctx))
  }

  getVeNfts(owner = this.account): Promise<VeNft[]> {
    return runSugar(venftsApi.getVeNfts(this.ctx, owner))
  }

  getVeNft(tokenId: bigint): Promise<VeNft | undefined> {
    return runSugar(venftsApi.getVeNft(this.ctx, tokenId))
  }

  getVeNftRewards(tokenId: bigint, pool?: Address): Promise<VeNftReward[]> {
    return runSugar(venftsApi.getVeNftRewards(this.ctx, tokenId, pool))
  }

  createVeNft(amount: bigint, lockDurationSeconds: number): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.createVeNft(this.ctx, amount, lockDurationSeconds))
  }

  increaseVeNftAmount(tokenId: bigint, amount: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.increaseVeNftAmount(this.ctx, tokenId, amount))
  }

  extendVeNftLock(tokenId: bigint, lockDurationSeconds: number): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.extendVeNftLock(this.ctx, tokenId, lockDurationSeconds))
  }

  withdrawVeNft(tokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.withdrawVeNft(this.ctx, tokenId))
  }

  mergeVeNfts(fromTokenId: bigint, intoTokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.mergeVeNfts(this.ctx, fromTokenId, intoTokenId))
  }

  splitVeNft(tokenId: bigint, amount: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.splitVeNft(this.ctx, tokenId, amount))
  }

  setVeNftPermanent(tokenId: bigint, permanent: boolean): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.setVeNftPermanent(this.ctx, tokenId, permanent))
  }

  delegateVeNft(tokenId: bigint, delegateTokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.delegateVeNft(this.ctx, tokenId, delegateTokenId))
  }

  voteVeNft(tokenId: bigint, votes: readonly VeNftVote[]): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.voteVeNft(this.ctx, tokenId, votes))
  }

  resetVeNftVotes(tokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.resetVeNftVotes(this.ctx, tokenId))
  }

  pokeVeNftVotes(tokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.pokeVeNftVotes(this.ctx, tokenId))
  }

  depositVeNftIntoManaged(tokenId: bigint, managedTokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.depositVeNftIntoManaged(this.ctx, tokenId, managedTokenId))
  }

  withdrawVeNftFromManaged(tokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.withdrawVeNftFromManaged(this.ctx, tokenId))
  }

  claimVeNftRewards(tokenId: bigint, pool?: Address): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.claimVeNftRewards(this.ctx, tokenId, pool))
  }

  getVeNftRebase(tokenId: bigint): Promise<bigint> {
    return runSugar(venftsApi.getVeNftRebase(this.ctx, tokenId))
  }

  claimVeNftRebase(tokenId: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.claimVeNftRebase(this.ctx, tokenId))
  }

  claimVeNftRebases(tokenIds: readonly bigint[]): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.claimVeNftRebases(this.ctx, tokenIds))
  }

  getPoolRewardContracts(pool: LiquidityPool): Promise<PoolRewardContracts> {
    return runSugar(venftsApi.getPoolRewardContracts(this.ctx, pool))
  }

  incentivizePool(pool: LiquidityPool, token: Token, amount: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(venftsApi.incentivizePool(this.ctx, pool, token, amount))
  }

  // --- positions ---

  getPositions(owner = this.account): Promise<Position[]> {
    return runSugar(positionsApi.getPositions(this.ctx, owner))
  }

  getPositionById(id: bigint, owner = this.account, poolAddress?: Address): Promise<Position | undefined> {
    return runSugar(positionsApi.getPositionById(this.ctx, id, owner, poolAddress))
  }

  getPositionsByPool(poolAddress: Address, owner = this.account): Promise<Position[]> {
    return runSugar(positionsApi.getPositionsByPool(this.ctx, poolAddress, owner))
  }

  getPositionByPool(poolAddress: Address, owner = this.account): Promise<Position | undefined> {
    return runSugar(positionsApi.getPositionByPool(this.ctx, poolAddress, owner))
  }

  // --- quotes ---

  filterPoolsForSwap(pools: LiquidityPoolForSwap[], fromToken: Token, toToken: Token): LiquidityPoolForSwap[] {
    return quotesApi.filterPoolsForSwap(this.ctx, pools, fromToken, toToken)
  }

  getPathsForQuote(fromToken: Token, toToken: Token, pools: LiquidityPoolForSwap[], excludedAddresses = this.settings.excludedTokenAddresses): PathHop[][] {
    return quotesApi.getPathsForQuote(this.ctx, fromToken, toToken, pools, excludedAddresses)
  }

  getQuote(fromToken: Token, toToken: Token, amount: bigint, filter?: (quote: Quote) => boolean): Promise<Quote | undefined> {
    return runSugar(quotesApi.getQuote(this.ctx, fromToken, toToken, amount, filter))
  }

  // --- transactions ---

  checkTokenAllowance(token: Token, spender: Address): Promise<bigint> {
    return runSugar(transactionsApi.checkTokenAllowance(this.ctx, token, spender))
  }

  setTokenAllowance(token: Token, spender: Address, amount: bigint): Promise<UnsignedTransaction | undefined> {
    return runSugar(transactionsApi.setTokenAllowance(this.ctx, token, spender, amount))
  }

  revokeTokenAllowance(token: Token, spender: Address): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.revokeTokenAllowance(this.ctx, token, spender))
  }

  revokePermit2Allowance(token: Token): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.revokePermit2Allowance(this.ctx, token))
  }

  bridge(fromToken: Token, amount: bigint, domain: number): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.bridge(this.ctx, fromToken, amount, domain))
  }

  swap(fromToken: Token, toToken: Token, amount: bigint, slippage?: number): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.swap(this.ctx, fromToken, toToken, amount, slippage))
  }

  swapBasketFromQuotes(quotes: Quote[], slippage = this.settings.swapSlippage): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.swapBasketFromQuotes(this.ctx, quotes, slippage))
  }

  swapFromQuote(quote: Quote, slippage = this.settings.swapSlippage): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.swapFromQuote(this.ctx, quote, slippage))
  }

  poolSpec(token0: Token, token1: Token, options: { tickSpacing?: number; stable?: boolean }): Promise<LiquidityPool> {
    return runSugar(transactionsApi.poolSpec(this.ctx, token0, token1, options))
  }

  quoteBasicDeposit(pool: LiquidityPool, amounts: { amountToken0?: bigint; amountToken1?: bigint }): Promise<DepositQuote> {
    return runSugar(transactionsApi.quoteBasicDeposit(this.ctx, pool, amounts))
  }

  quoteConcentratedDeposit(pool: LiquidityPool, options: {
    priceLower?: number; priceUpper?: number; tickLower?: number; tickUpper?: number
    amountToken0?: bigint; amountToken1?: bigint; initialPrice?: number
  }): Promise<DepositQuote> {
    return runSugar(transactionsApi.quoteConcentratedDeposit(this.ctx, pool, options))
  }

  deposit(quote: DepositQuote, deadlineMinutes = 30, slippage = 0.01): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.deposit(this.ctx, quote, deadlineMinutes, slippage))
  }

  withdraw(withdrawal: Withdrawal, deadlineMinutes = 30, slippage = 0.01, collect = true, unwrapNative = false): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.withdraw(this.ctx, withdrawal, deadlineMinutes, slippage, collect, unwrapNative))
  }

  stake(position: Position): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.stake(this.ctx, position))
  }

  unstake(position: Position, amount?: bigint): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.unstake(this.ctx, position, amount))
  }

  claimEmissions(position: Position): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.claimEmissions(this.ctx, position))
  }

  claimFees(position: Position, burn = false, unwrapNative = false): Promise<UnsignedTransaction[]> {
    return runSugar(transactionsApi.claimFees(this.ctx, position, burn, unwrapNative))
  }
}

export function createSugarClient(chainId: ChainId | number, options: SugarClientOptions = {}): SugarClient {
  return new SugarClient(chainId, options)
}
