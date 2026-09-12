import type * as Cache from 'effect/Cache'
import type * as Effect from 'effect/Effect'
import type { Abi, Address, Hex, PublicClient } from 'viem'
import type { SugarClient } from '../client'
import type { SugarRpcError } from '../errors'
import type { RpcDeadline, RpcReadExecutor, RpcReadTask } from './rpc-executor'
import type {
  ChainSettings,
  SugarClientCaches,
  SugarPoolLocatorStore,
  SugarRpcEvent,
  UnsignedTransaction,
  VeNftContracts,
} from '../types'

export type ReadArgs = readonly unknown[] | undefined

/** A Sugar pool located by catalog offset, with its verified raw tuple. */
export type ResolvedPoolLocator = { offset: number; rawPool: unknown }

/**
 * Shared per-client state and RPC primitives handed to the domain modules
 * (tokens, prices, pools, venfts, positions, quotes, transactions). The
 * SugarClient facade builds exactly one context in its constructor, so all
 * caches keep client-instance identity and semantics.
 */
export interface SugarContext {
  /**
   * Back-reference to the owning client. Cross-domain calls that previously
   * went through `this.publicMethod()` keep using the instance so dynamic
   * dispatch is preserved: an instance or subclass override of a public
   * method (e.g. getPathsForQuote) still affects composite flows that call
   * it (e.g. getQuote), exactly as before the extraction.
   */
  readonly client: SugarClient
  readonly settings: ChainSettings
  readonly account?: Address
  readonly publicClient: PublicClient
  readonly rpc: RpcReadExecutor
  readonly caches: SugarClientCaches
  readonly poolLocatorStore?: SugarPoolLocatorStore
  /** Verified pool-offset lookups, deduped per client; failures are not cached. */
  readonly resolvedPoolLocators: Cache.Cache<string, ResolvedPoolLocator | undefined, SugarRpcError>
  veNftContractsCache?: Cache.Cache<'contracts', VeNftContracts, SugarRpcError>
  readTask<T>(address: Address, abi: Abi, functionName: string, args?: ReadArgs): RpcReadTask<T>
  read<T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args?: ReadArgs,
    deadline?: RpcDeadline,
  ): Effect.Effect<T, SugarRpcError>
  signer(): Address
  tx(to: Address, data: Hex, value?: bigint): UnsignedTransaction
  encode(abi: Abi, functionName: string, args?: readonly unknown[]): Hex
  emitRpcEvent(event: SugarRpcEvent): void
}
