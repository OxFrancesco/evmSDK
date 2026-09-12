// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import type * as Cache from 'effect/Cache'
import type { Address, Hex, PublicClient, Transport } from 'viem'
import type { SugarRpcError } from './errors'
import type { SugarContext } from './internal/context'

export const ADDRESS_ZERO: Address = '0x0000000000000000000000000000000000000000'
export const MAX_UINT128 = (1n << 128n) - 1n
export const MAX_UINT256 = (1n << 256n) - 1n
export const MAX_UINT160 = (1n << 160n) - 1n
export const MAX_ABS_TICK = 887_272
export const QUOTER_STABLE_POOL_FILLER = 2_097_152
export const QUOTER_VOLATILE_POOL_FILLER = 4_194_304
export const NEW_SLIPSTREAM_FACTORY_BITMASK = 0x080000
export const OLD_SLIPSTREAM_FACTORY_BITMASK = 0x100000
export const XCHAIN_GAS_LIMIT_UPPERBOUND = 600_000n

export type ChainId =
  | 10
  | 130
  | 252
  | 1135
  | 1868
  | 5330
  | 8453
  | 34443
  | 42220
  | 57073

export type ChainSettings = {
  chainId: ChainId
  chainName: string
  rpcUrl: string
  wrappedNativeTokenAddress: Address
  interchainRouterContractAddress: Address
  bridgeContractAddress: Address
  bridgeTokenAddress: Address
  messageModuleContractAddress: Address
  sugarContractAddress: Address
  sugarRewardsContractAddress: Address
  veSugarContractAddress?: Address
  voterContractAddress: Address
  slipstreamContractAddress: Address
  slipstreamFactoryAddress: Address
  oldSlipstreamFactoryAddress: Address
  nfpmContractAddress: Address
  priceOracleContractAddress: Address
  routerContractAddress: Address
  quoterContractAddress: Address
  swapperContractAddress: Address
  tokenAddress?: Address
  stableTokenAddress: Address
  connectorTokenAddresses: Address[]
  excludedTokenAddresses: Address[]
  swapSlippage: number
  quoteMaxPaths: number
  quoteBatchSize: number
  priceBatchSize: number
  priceThresholdFilter: number
  paginationLimit: number
  poolPaginationTargetCalls: number
  poolPaginationMinSize: number
  poolPaginationMaxSize: number
  nativeTokenSymbol: string
  nativeTokenDecimals: number
  pricingCacheTimeoutSeconds: number
  requestConcurrency: number
}

export type SugarRpcPolicyOptions = {
  baseDelayMs?: number
  deadlineMs?: number
  maxRetries?: number
}

export type SugarRpcEvent = Readonly<{
  /** Stable operation name such as `positions` or `quoteExactInput.multicall`. */
  operation: string
  phase: 'batch' | 'pagination' | 'read' | 'transport'
  status: 'error' | 'success'
  attemptCount: number
  durationMs?: number
  itemCount?: number
  pageCount?: number
  /** Present for transport events where endpoint selection is observable. */
  failoverUsed?: boolean
}>

/** Receives low-cardinality RPC telemetry. Request parameters are never included. */
export type SugarRpcObserver = (event: SugarRpcEvent) => void

export type SugarClientOptions = {
  account?: Address
  rpcUrl?: string
  transport?: Transport
  publicClient?: PublicClient
  env?: Record<string, string | undefined>
  onRpcEvent?: SugarRpcObserver
  rpcPolicy?: SugarRpcPolicyOptions
  settings?: Partial<ChainSettings>
  cacheStore?: SugarCacheStore
  poolLocatorStore?: SugarPoolLocatorStore
}

export type SugarPoolLocatorKey = Readonly<{
  chainId: number
  sugarContractAddress: Address
  poolAddress: Address
}>

export type SugarPoolLocator = Readonly<{ offset: number }>

/** Durable address-to-Sugar-offset cache. Every hit is verified on-chain. */
export type SugarPoolLocatorStore = {
  get(key: SugarPoolLocatorKey): Promise<SugarPoolLocator | undefined>
  set(key: SugarPoolLocatorKey, locator: SugarPoolLocator): Promise<void>
  delete(key: SugarPoolLocatorKey): Promise<void>
}

/**
 * Mutable read caches a SugarClient consults before hitting the RPC. Keyed
 * caches are `effect/Cache` handles: concurrent lookups for a missing key
 * share one in-flight read and failed lookups are never retained. Handles are
 * created lazily by the first client that needs them, so a shared store entry
 * keeps serving every client on the same chain and RPC.
 */
export type SugarClientCaches = {
  ttlMs?: number
  poolCountExpiresAt?: number
  /**
   * @internal The client currently driving a shared-cache lookup. Shared
   * lookups are late-bound to this context so one client's broken transport
   * never poisons the store for healthy clients (see internal/caches.ts).
   */
  activeContext?: SugarContext
  /** Full token catalog; `listedOnly` filtering happens after the lookup. */
  tokenCache?: Cache.Cache<'catalog', Token[], SugarRpcError>
  /**
   * Pool count reads participate in the caller's pagination deadline, which
   * is a per-call argument that a keyed cache lookup cannot carry — so this
   * stays a deduplicating promise slot cleared on failure.
   */
  poolCountCache?: Promise<number>
  rawPoolCache?: Cache.Cache<boolean, unknown[], SugarRpcError>
  poolCache?: Cache.Cache<boolean, LiquidityPool[] | LiquidityPoolForSwap[], SugarRpcError>
  /**
   * Oracle rates by token address, refreshed after
   * pricingCacheTimeoutSeconds. Rates are filled from batched oracle calls
   * (many keys per read), not per-key lookups, so a keyed cache does not fit.
   */
  priceRateCache: Map<string, { expiresAt: number; rate: bigint }>
  /** The swapper's immutable PERMIT2 address; one read per cache lifetime. */
  permit2AddressCache?: Cache.Cache<'permit2', Address, SugarRpcError>
}

/**
 * Shares chain-level read caches (tokens, pool topology) across SugarClient
 * instances, so repeated quotes do not re-scan every pool on each request.
 */
export type SugarCacheStore = {
  cachesFor(chainId: number, rpcUrl: string, settingsKey?: string): SugarClientCaches
  invalidate?(): Promise<void>
}

export type Token = {
  chainId: ChainId
  chainName: string
  tokenAddress: string
  symbol: string
  decimals: number
  listed: boolean
  emerging: boolean
  wrappedTokenAddress?: Address
}

export type Price = { token: Token; price: number }

export type Amount = {
  token: Token
  amount: bigint
  price: Price
  decimal: number
  amountInStable: number
}

export type LiquidityPoolForSwap = {
  chainId: ChainId
  chainName: string
  lp: Address
  type: number
  token0Address: Address
  token1Address: Address
  factory?: Address
  isCl: boolean
  isStable: boolean
  isBasic: boolean
}

export type LiquidityPool = {
  chainId: ChainId
  chainName: string
  lp: Address
  factory: Address
  symbol: string
  type: number
  isStable: boolean
  isCl: boolean
  tick: number
  sqrtRatio: bigint
  totalSupply: bigint
  decimals: number
  token0: Token
  reserve0?: Amount
  token1: Token
  reserve1?: Amount
  token0Fees?: Amount
  token1Fees?: Amount
  poolFee: bigint
  gauge: Address
  gaugeAlive: boolean
  gaugeTotalSupply: bigint
  emissions?: Amount
  emissionsToken?: Token
  weeklyEmissions?: Amount
  nfpm: Address
  alm: Address
  tvl: number
  totalFees: number
  volume: number
  token0Volume: number
  token1Volume: number
  apr: number
}

export type LiquidityPoolEpoch = {
  ts: number
  lp: Address
  pool?: LiquidityPool
  votes: bigint
  emissions: bigint
  incentives: Amount[]
  fees: Amount[]
  totalFees: number
  totalIncentives: number
  epochDate: string
}

export type VeNftState = 'normal' | 'locked' | 'managed'

export type VeNftVote = {
  pool: Address
  weight: bigint
}

export type VeNft = {
  chainId: ChainId
  chainName: string
  id: bigint
  owner: Address
  decimals: number
  lockedAmount: bigint
  votingPower: bigint
  governancePower: bigint
  claimableRebase: bigint
  expiresAt: number
  votedAt: number
  votes: VeNftVote[]
  governanceToken: Address
  permanent: boolean
  delegateId: bigint
  managedId: bigint
  state: VeNftState
}

export type VeNftContracts = {
  veSugar: Address
  voter: Address
  votingEscrow: Address
  governanceToken: Address
  rewardsDistributor: Address
}

export type VeNftReward = {
  veNftId: bigint
  pool: Address
  amount: bigint
  token: Address
  feeVotingReward: Address
  incentiveVotingReward: Address
}

export type PoolRewardContracts = {
  gauge: Address
  feeVotingReward: Address
  incentiveVotingReward: Address
}

export type Position = {
  chainId: ChainId
  chainName: string
  id: bigint
  pool: LiquidityPool
  liquidity: bigint
  staked: bigint
  amountToken0: bigint
  amountToken1: bigint
  stakedToken0: bigint
  stakedToken1: bigint
  unstakedEarned0: bigint
  unstakedEarned1: bigint
  emissionsEarned: bigint
  tickLower: number
  tickUpper: number
  sqrtRatioLower: bigint
  sqrtRatioUpper: bigint
  alm: Address
  isCl: boolean
  isAlm: boolean
  isInRange: boolean
}

export type PathHop = { pool: LiquidityPoolForSwap; reversed: boolean }
export type PreparedRoute = { types: string[]; values: Array<Address | number | boolean>; encoded: Hex }
export type QuoteInput = {
  fromToken: Token
  toToken: Token
  path: PathHop[]
  amountIn: bigint
  slipstreamFactoryAddress?: Address
  oldSlipstreamFactoryAddress?: Address
}
export type Quote = { input: QuoteInput; amountOut: bigint }

export type DepositQuote = {
  pool: LiquidityPool
  amountToken0: bigint
  amountToken1: bigint
  tickLower?: number
  tickUpper?: number
  sqrtPriceX96: bigint
}

export type Withdrawal = {
  pool: LiquidityPool
  liquidity: bigint
  amountToken0: bigint
  amountToken1: bigint
  positionId?: bigint
  burn: boolean
}

export type UnsignedTransaction = {
  from: Address
  to: Address
  data: Hex
  value: bigint
}

export type IcaCall = { to: Hex; value: bigint; data: Hex }
export type SuperSwapData = {
  destinationPlanner: RoutePlan
  calls: IcaCall[]
  originDomain: number
  salt: Hex
  needsRelay: boolean
  commitmentHash?: Hex
}
export type SuperswapQuote = {
  fromToken: Token
  toToken: Token
  amountIn: bigint
  fromBridgeToken: Token
  toBridgeToken: Token
  originQuote?: Quote
  destinationQuote?: Quote
  amountOut: bigint
  bridgedAmount: bigint
  isBridge: boolean
}
export type SuperswapPlan = {
  transactions: UnsignedTransaction[]
  swapData?: SuperSwapData
  relay?: {
    calls: IcaCall[]
    salt: Hex
    originDomain: number
  }
}

export type RoutePlan = { commands: Hex; inputs: Hex[] }

export type SuperSwapDataInput = {
  fromToken: Token
  toToken: Token
  fromBridgeToken: Token
  toBridgeToken: Token
  account: Address
  userIca: Address
  userIcaBalance: bigint
  originDomain: number
  originBridge: Address
  originHook: Address
  originIcaRouter: Address
  destinationIcaRouter: Address
  destinationRouter: Address
  destinationDomain: number
  slippage: number
  swapperContractAddress: Address
  salt: Hex
  bridgeFee: bigint
  xchainFee: bigint
  destinationQuote?: Quote
}

export type SugarJson = null | boolean | number | string | SugarJson[] | { [key: string]: SugarJson }
