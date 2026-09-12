import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Config, Effect, Layer, Option, Redacted, Schema } from 'effect'
import type { LocalAccount } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Signer } from './execution'
import { Wallets, walletsLayer } from './wallets'
import type { ExternalSigner } from './wallets'
import { socketLayer } from './socket'
import type { SocketOptions } from './socket'
import { EvmError, Hash } from './model'
import { networkLayer } from './network'
import type { NetworkOptions } from './network'
import { storeLayer } from './storage'

export interface RuntimeOptions extends NetworkOptions, SocketOptions {
  readonly interactive?: boolean
  readonly policy?: string
  readonly walletProjectId?: string
  readonly smartWalletUrl?: string
  readonly onPairing?: (message: string) => void
  readonly externalSigner?: ExternalSigner
  readonly database: string
  readonly signer?: LocalAccount
}

export function runtimeLayer(options: RuntimeOptions) {
  const wallets = walletsLayer({ smartWalletUrl: options.smartWalletUrl, directory: join(dirname(options.database), 'wallets'), interactive: options.interactive ?? false, projectId: options.walletProjectId ?? 'cebb813303780775ef7c4a93f1daadee', onPairing: options.onPairing ?? (message => { process.stderr.write(`${message}\n`) }) })
  const signing = Layer.effect(Signer, Effect.gen(function* () {
    const manager = yield* Wallets
    return Signer.of({ account: options.signer ?? null, policy: options.policy, external: options.externalSigner ? () => Effect.succeed(options.externalSigner ?? null) : manager.signer })
  })).pipe(Layer.provide(wallets))
  return Layer.mergeAll(networkLayer(options), storeLayer(options.database), signing, wallets, socketLayer(options))
}

export const environmentOptions = Effect.fn('Runtime.configuration')(function* () {
  const database = yield* Config.string('EVM_DATABASE').pipe(Config.withDefault(join(homedir(), '.local', 'share', 'bee-evm', 'operations.sqlite')))
  const rpc = yield* Config.option(Config.string('EVM_RPC_URL'))
  const explorer = yield* Config.option(Config.redacted('EVM_ETHERSCAN_API_KEY'))
  const rpcFallbackConfig = yield* Config.option(Config.string('EVM_RPC_URLS'))
  const rpcFallbacks = new Map<number, ReadonlyArray<string>>()
  if (Option.isSome(rpcFallbackConfig)) {
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.String))))(rpcFallbackConfig.value).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'EVM_RPC_URLS must be JSON mapping chain IDs to RPC URL arrays.', retryable: false })))
    for (const [chain, urls] of Object.entries(decoded)) rpcFallbacks.set(Number(chain), urls)
  }
  const policy = yield* Config.option(Config.string('EVM_POLICY'))
  const socketApiKey = yield* Config.option(Config.redacted('SOCKET_API_KEY'))
  const socketAffiliate = yield* Config.option(Config.string('SOCKET_AFFILIATE'))
  const socketUrl = yield* Config.option(Config.string('SOCKET_API_URL'))
  const walletProjectId = yield* Config.option(Config.string('WALLETCONNECT_PROJECT_ID'))
  const smartWalletUrl = yield* Config.option(Config.string('EVM_SMART_WALLET_URL'))
  const key = yield* Config.option(Config.redacted('EVM_PRIVATE_KEY'))
  let signer: LocalAccount | undefined
  if (Option.isSome(key)) {
    const privateKey = yield* Schema.decodeUnknownEffect(Hash)(Redacted.value(key.value)).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'EVM_PRIVATE_KEY must contain a valid 32-byte private key.', retryable: false })))
    signer = yield* Effect.try({ try: () => privateKeyToAccount(privateKey), catch: () => new EvmError({ code: 'InvalidInput', message: 'EVM_PRIVATE_KEY is not a valid signing key.', retryable: false }) })
  }
  return { database, rpcFallbacks, smartWalletUrl: Option.getOrUndefined(smartWalletUrl), policy: Option.getOrUndefined(policy), socketApiKey: Option.getOrUndefined(socketApiKey), socketAffiliate: Option.getOrUndefined(socketAffiliate), socketUrl: Option.getOrUndefined(socketUrl), walletProjectId: Option.getOrUndefined(walletProjectId), rpcUrl: Option.getOrUndefined(rpc), etherscanApiKey: Option.getOrUndefined(explorer), signer } satisfies RuntimeOptions
})
