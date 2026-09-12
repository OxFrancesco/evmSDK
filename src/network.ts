import { Context, Effect, Layer, Redacted } from 'effect'
import { BaseError, createPublicClient, defineChain, fallback, http } from 'viem'
import { mainnet, base, baseSepolia, sepolia, arbitrum, optimism, polygon, bsc } from 'viem/chains'
import { EvmError } from './model'

export interface NetworkOptions {
  readonly rpcFallbacks?: ReadonlyMap<number, ReadonlyArray<string>>
  readonly rpcUrls?: ReadonlyMap<number, string>
  readonly rpcUrl?: string
  readonly etherscanApiKey?: Redacted.Redacted<string>
}

const chains = [mainnet, base, baseSepolia, sepolia, arbitrum, optimism, polygon, bsc]
const defaults = new Map([
  [1, 'https://ethereum-rpc.publicnode.com'], [8453, 'https://mainnet.base.org'],
  [11155111, 'https://ethereum-sepolia-rpc.publicnode.com'], [84532, 'https://sepolia.base.org'],
  [31337, 'http://127.0.0.1:8545'], [42161, 'https://arbitrum-one-rpc.publicnode.com'], [10, 'https://optimism-rpc.publicnode.com'], [137, 'https://polygon-bor-rpc.publicnode.com'], [56, 'https://bsc-rpc.publicnode.com'],
])

function client(chainId: number, url: string, alternates: ReadonlyArray<string> = []) {
  const known = chains.find(chain => chain.id === chainId)
  const symbol = known?.nativeCurrency.symbol ?? 'native'
  return createPublicClient({
    chain: defineChain({ ...known, id: chainId, name: `EVM ${chainId}`, nativeCurrency: { name: symbol, symbol, decimals: 18 }, rpcUrls: { default: { http: [url] } } }),
    transport: alternates.length ? fallback([url, ...alternates].map(endpoint => http(endpoint, { timeout: 15_000, retryCount: 0 })), { rank: false, retryCount: 0 }) : http(url, { timeout: 15_000, retryCount: 0 }),
  })
}

export const rpc = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: error => new EvmError({
    code: 'RpcError', retryable: true,
    message: error instanceof BaseError ? error.shortMessage.replace(/https?:\/\/\S+/g, '[RPC endpoint]') : 'RPC request failed.',
  }),
})

export class Network extends Context.Service<Network, {
  readonly client: (chainId: number) => Effect.Effect<ReturnType<typeof client>, EvmError>
  readonly options: NetworkOptions
}>()('@beegreat/evm/Network') {}

export function networkLayer(options: NetworkOptions) {
  return Layer.succeed(Network, Network.of({
    options,
    client: Effect.fn('Network.client')(function* (chainId) {
      const url = options.rpcUrls?.get(chainId) ?? options.rpcUrl ?? options.rpcFallbacks?.get(chainId)?.[0] ?? defaults.get(chainId)
      if (!url) return yield* new EvmError({ code: 'InvalidInput', message: `Configure an RPC URL for chain ${chainId}.`, retryable: false })
      const candidates = [...new Set([url, ...(options.rpcFallbacks?.get(chainId) ?? [])])]
      const checked = yield* Effect.forEach(candidates, endpoint => rpc(() => client(chainId, endpoint).getChainId()).pipe(Effect.map(actual => ({ endpoint, actual })), Effect.result), { concurrency: 4 })
      const valid: string[] = []
      for (const result of checked) {
        if (result._tag === 'Failure') continue
        if (result.success.actual !== chainId) return yield* new EvmError({ code: 'ChainMismatch', message: `Requested chain ${chainId}, but a configured RPC reports ${result.success.actual}.`, retryable: false })
        valid.push(result.success.endpoint)
      }
      const [primary, ...alternates] = valid
      if (!primary) return yield* new EvmError({ code: 'RpcError', message: 'No configured RPC endpoint is responding for this chain.', retryable: true })
      return client(chainId, primary, alternates)
    }),
  }))
}
