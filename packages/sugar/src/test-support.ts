import * as Predicate from 'effect/Predicate'
import type { Address, PublicClient } from 'viem'
import type { SugarClient } from './client'
import type { RpcReadExecutor } from './internal/rpc-executor'
import type { LiquidityPoolForSwap, Price, Quote, Token, UnsignedTransaction } from './types'

/**
 * Shape of the `readContract` requests the Sugar client issues, as observed by
 * the stubbed viem clients used in tests.
 */
export interface ReadContractStubRequest {
  readonly args?: readonly unknown[]
  readonly functionName: string
}

/** Values the stubbed `readContract` handlers produce in tests. */
export type ReadContractStubResult = bigint | boolean | number | string | undefined | readonly unknown[]

/** A stubbed `readContract` implementation, as accepted by `stubPublicClient`. */
export type ReadContractStub = (request: ReadContractStubRequest) => Promise<ReadContractStubResult>

/** Shape of the `multicall` requests observed by the stubbed viem clients. */
export interface MulticallStubRequest {
  readonly contracts: readonly unknown[]
}

/** One entry of a stubbed `multicall` response. */
export interface MulticallStubResult {
  readonly status: string
  readonly result?: readonly unknown[] | undefined
}

/** The subset of the viem `PublicClient` surface exercised by the tests. */
export interface PublicClientStub {
  readonly readContract?: ReadContractStub
  readonly multicall?: (request: MulticallStubRequest) => Promise<readonly MulticallStubResult[]>
  readonly getBalance?: () => Promise<bigint>
}

/** Presents a test-only `readContract` implementation as a `PublicClient`. */
export function stubPublicClient(stub: PublicClientStub): PublicClient {
  const client: object = stub
  // SAFETY: tests exercise only the stubbed subset of the viem PublicClient surface.
  return client as PublicClient
}

/** The subset of the `SugarClient` surface exercised by the action-seam tests. */
export interface SugarClientStub {
  readonly settings?: {
    readonly nativeTokenSymbol: string
    readonly stableTokenAddress: string
    readonly swapSlippage: number
  }
  readonly getPoolsForSwaps?: () => Promise<LiquidityPoolForSwap[]>
  readonly getToken?: (reference: string) => Promise<Token | undefined>
  readonly getPrices?: (tokens: Token[]) => Promise<Price[]>
  readonly getQuote?: (
    fromToken: Token,
    toToken: Token,
    amountIn: bigint,
    filter?: (quote: Quote) => boolean,
  ) => Promise<Quote | undefined>
  readonly swapFromQuote?: () => Promise<UnsignedTransaction[]>
  readonly getVeNftContracts?: () => Promise<{ governanceToken: string }>
  readonly createVeNft?: () => Promise<UnsignedTransaction[]>
  readonly checkTokenAllowance?: (token: Token, spender: Address) => Promise<bigint>
  readonly getPoolByAddress?: () => Promise<{
    readonly isCl: boolean
    readonly lp: string
    readonly token0: { readonly symbol: string; readonly decimals: number }
    readonly token1: { readonly symbol: string; readonly decimals: number }
  }>
}

/** Presents a partial, test-only implementation as a `SugarClient`. */
export function stubSugarClient(stub: SugarClientStub): SugarClient {
  const client: object = stub
  // SAFETY: tests exercise only the stubbed subset of the SugarClient surface.
  return client as SugarClient
}

/** A test double covering only the call signature of global `fetch`. */
export type FetchStub = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>

/** Presents a request handler as the global `fetch` function. */
export function stubFetch(handler: FetchStub): typeof fetch {
  // SAFETY: the code under test invokes only fetch's call signature; the static
  // helpers Bun attaches to fetch (e.g. preconnect) are never exercised.
  return handler as typeof fetch
}

/** Reads a `readContract` argument the contract ABI declares as an address list. */
export function stringListArgument(request: ReadContractStubRequest, index: number): string[] {
  const value = request.args?.[index]
  if (Array.isArray(value) && value.every(Predicate.isString)) return value
  throw new Error(`Expected a string list at argument ${index} of ${request.functionName}`)
}

const isAddress = (value: string): value is Address => value.startsWith('0x')

/** Returns a token's on-chain address, verified to be hex at runtime. */
export function addressOf(token: Token): Address {
  if (isAddress(token.tokenAddress)) return token.tokenAddress
  throw new Error(`Token ${token.symbol} has no hex address: ${token.tokenAddress}`)
}

/** Narrows a rejection value to the expected error class, or fails the test. */
export function expectInstanceOf<T>(cause: unknown, constructor: new (...args: never[]) => T): T {
  if (cause instanceof constructor) return cause
  throw new Error(`Expected an instance of ${constructor.name}, got: ${String(cause)}`)
}

/** The patchable slice of the RPC executor a SugarClient carries. */
export interface RpcExecutorPatch {
  forEachReadResult: RpcReadExecutor['forEachReadResult']
}

interface SugarClientRpcInternals {
  readonly rpc: RpcExecutorPatch
}

/** Exposes a SugarClient's protected RPC executor so tests can observe reads. */
export function rpcExecutorOf(client: SugarClient): RpcExecutorPatch {
  const widened: object = client
  // SAFETY: SugarClient constructs its protected `rpc` field as an
  // RpcReadExecutor; tests re-point forEachReadResult at a delegating wrapper
  // to observe read operations.
  return (widened as SugarClientRpcInternals).rpc
}
