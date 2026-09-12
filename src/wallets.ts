import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Effect, Context, Layer, Schema } from 'effect'
import { numberToHex, stringify } from 'viem'
import type { Plan } from './model'
import { Address, EvmError } from './model'
import { startBrowserWallet, decodeWalletHash } from './browser-wallet'
import { SmartTransaction } from './crossmint'
import type { SmartWalletAdapter } from './crossmint'

const WalletRecord = Schema.Struct({ name: Schema.String, address: Address, kind: Schema.Literals(['browser', 'walletconnect', 'crossmint']), peer: Schema.String, topic: Schema.optionalKey(Schema.String), chains: Schema.Array(Schema.Number) })
const WalletFile = Schema.Struct({ active: Schema.NullOr(Schema.String), wallets: Schema.Array(WalletRecord) })
export interface WalletRecord extends Schema.Schema.Type<typeof WalletRecord> {}
export interface ExternalSigner {
  readonly address: Schema.Schema.Type<typeof Address>
  readonly interactive: boolean
  readonly smart?: SmartWalletAdapter
  readonly preflight?: (chainId: number) => Promise<void>
  readonly send: (plan: Plan, nonce: number) => Promise<Schema.Schema.Type<typeof Address> | `0x${string}`>
  readonly request?: (method: string, params: ReadonlyArray<Schema.Json>, chainId: number) => Promise<Schema.Json>
}
export interface WalletOptions {
  readonly directory: string
  readonly interactive: boolean
  readonly projectId: string
  readonly smartWalletUrl?: string
  readonly onPairing: (message: string) => void
}
export class Wallets extends Context.Service<Wallets, {
  readonly list: () => Effect.Effect<Schema.Schema.Type<typeof WalletFile>, EvmError>
  readonly connect: (kind: WalletRecord['kind'], chainId: number, name: string) => Effect.Effect<WalletRecord, EvmError>
  readonly select: (name: string) => Effect.Effect<WalletRecord, EvmError>
  readonly disconnect: (name: string) => Effect.Effect<{ removed: string }, EvmError>
  readonly signer: () => Effect.Effect<ExternalSigner | null, EvmError>
}>()('@beegreat/evm/Wallets') {}

export function walletsLayer(options: WalletOptions) {
  return Layer.effect(Wallets, Effect.gen(function* () {
    let bridge: ReturnType<typeof startBrowserWallet> | undefined
    type WC = Awaited<ReturnType<typeof import('@walletconnect/sign-client')['SignClient']['init']>>
    let wc: WC | undefined
    const file = join(options.directory, 'accounts.json')
    const read = () => existsSync(file) ? Schema.decodeUnknownSync(Schema.fromJsonString(WalletFile))(readFileSync(file, 'utf8')) : { active: null, wallets: [] }
    const write = (data: Schema.Schema.Type<typeof WalletFile>) => {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 }); renameSync(temporary, file)
    }
    const boundary = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error instanceof EvmError ? error : new EvmError({ code: 'SignerInteractionRequired', message: error instanceof Error ? error.message.replace(/wc:[^\s]+/g, '[pairing URI]') : 'Wallet connection failed.', retryable: false }) })
    const client = async () => {
      if (!wc) {
        const { SignClient } = await import('@walletconnect/sign-client')
        mkdirSync(options.directory, { recursive: true, mode: 0o700 })
        wc = await SignClient.init({ projectId: options.projectId, metadata: { name: 'BeeGreat EVM', description: 'Independent EVM toolkit', url: 'https://beegreat.app', icons: [] }, storageOptions: { database: join(options.directory, 'walletconnect') } })
      }
      return wc
    }
    const open = async (chainId: number, expected?: string, smart = false) => {
      if (!options.interactive) throw new EvmError({ code: 'SignerInteractionRequired', message: 'Connect in the TUI or run wallet-connect from an interactive terminal. Agent mode never opens a browser.', retryable: false })
      bridge?.stop(); bridge = startBrowserWallet(chainId, expected, smart ? options.smartWalletUrl ?? 'https://beegreat.app/evm-wallet' : undefined)
      options.onPairing(bridge.url)
      const args = process.platform === 'darwin' ? ['open', bridge.url] : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', bridge.url] : ['xdg-open', bridge.url]
      const child = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' }); await child.exited
      return await bridge.connected
    }
    const request = async (record: WalletRecord, method: string, params: ReadonlyArray<Schema.Json>, chainId: number) => {
      if (!options.interactive) throw new EvmError({ code: 'SignerInteractionRequired', message: 'External wallets require wallet approval. Use an interactive terminal or an unattended SDK signer.', retryable: false })
      if (record.kind === 'crossmint' && !record.chains.includes(chainId)) throw new EvmError({ code: 'ChainMismatch', message: 'Connect a named smart wallet for the requested network first.', retryable: false })
      if (read().active !== record.name) throw new Error('Selected wallet changed. Review again.')
      if (record.kind === 'browser' || record.kind === 'crossmint') {
        if (!bridge?.isConnected()) await open(chainId, record.address, record.kind === 'crossmint')
        if (!bridge) throw new Error('Browser wallet is unavailable.')
        return await bridge.request(method, params, chainId)
      }
      const current = await client()
      const session = current.session.getAll().find(s => s.topic === record.topic)
      const permitted = Object.values(session?.namespaces ?? {}).some(n => n.methods.includes(method) && n.accounts.some(a => a.toLowerCase() === `eip155:${chainId}:${record.address.toLowerCase()}`))
      if (!session || session.expiry * 1000 < Date.now() || !permitted) throw new Error('WalletConnect session does not authorize this account, chain and method. Reconnect.')
      return Schema.decodeUnknownSync(Schema.Json)(await current.request({ topic: session.topic, chainId: `eip155:${chainId}`, request: { method, params } }))
    }
    yield* Effect.addFinalizer(() => Effect.promise(async () => { bridge?.stop(); if (wc) await wc.core.relayer.transportClose() }))
    return Wallets.of({
      list: Effect.fn('Wallets.list')(() => boundary(async () => read())),
      connect: Effect.fn('Wallets.connect')((kind, chainId, name) => boundary(async () => {
        if (read().wallets.some(w => w.name === name)) throw new Error('This wallet name already exists. Select or disconnect it first.')
        let record: WalletRecord
        if (kind === 'browser' || kind === 'crossmint') record = { ...await open(chainId, undefined, kind === 'crossmint'), name, kind, chains: [chainId] }
        else {
          if (!options.interactive) throw new Error('WalletConnect pairing requires an interactive terminal.')
          const connection = await client()
          const { uri, approval } = await connection.connect({ requiredNamespaces: { eip155: { methods: ['eth_sendTransaction'], chains: [`eip155:${chainId}`], events: ['accountsChanged', 'chainChanged'] } }, optionalNamespaces: { eip155: { methods: ['eth_signTypedData_v4', 'wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus'], chains: [1, 8453, 42161, 10, 137, 56].map(id => `eip155:${id}`), events: ['accountsChanged', 'chainChanged'] } } })
          if (!uri) throw new Error('WalletConnect did not provide a pairing URI.')
          const { renderUnicodeCompact } = await import('uqr'); options.onPairing(`${renderUnicodeCompact(uri)}\n${uri}`)
          const session = await approval()
          const accounts = Object.values(session.namespaces).flatMap(n => n.accounts)
          const account = accounts.find(a => a.startsWith(`eip155:${chainId}:`))
          const address = Schema.decodeUnknownSync(Address)(account?.split(':')[2])
          record = { name, kind, address, peer: session.peer.metadata.name, topic: session.topic, chains: accounts.filter(a => a.endsWith(address)).map(a => Number(a.split(':')[1])) }
        }
        const data = read(); write({ active: name, wallets: [...data.wallets, record] }); return record
      })),
      select: Effect.fn('Wallets.select')(name => boundary(async () => {
        const data = read(); const record = data.wallets.find(w => w.name === name)
        if (!record) throw new Error('Wallet name does not exist.')
        bridge?.stop(); bridge = undefined; write({ ...data, active: name }); return record
      })),
      disconnect: Effect.fn('Wallets.disconnect')(name => boundary(async () => {
        const data = read(); const record = data.wallets.find(w => w.name === name)
        if (record?.topic) { const connection = await client(); const session = connection.session.getAll().find(s => s.topic === record.topic); if (session) await connection.disconnect({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } }) }
        if (data.active === name) { bridge?.stop(); bridge = undefined }
        write({ active: data.active === name ? null : data.active, wallets: data.wallets.filter(w => w.name !== name) }); return { removed: name }
      })),
      signer: Effect.fn('Wallets.signer')(() => boundary(async () => {
        const data = read(); const record = data.wallets.find(w => w.name === data.active)
        if (!record) return null
        return {
          address: record.address, interactive: true,
          preflight: async chainId => {
            if (record.kind === 'crossmint' && !record.chains.includes(chainId)) throw new EvmError({ code: 'ChainMismatch', message: 'Connect a named smart wallet for the requested network first.', retryable: false })
            if (!options.interactive) throw new EvmError({ code: 'SignerInteractionRequired', message: 'External wallets require an interactive terminal. Use the TUI or configure an unattended SDK signer.', retryable: false })
            if (record.kind !== 'walletconnect' && !bridge?.isConnected()) await open(chainId, record.address, record.kind === 'crossmint')
          },
          smart: record.kind === 'crossmint' ? {
            provider: 'crossmint',
            prepare: async plan => Schema.decodeUnknownSync(SmartTransaction)(await request(record, 'evm_crossmintPrepare', [Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(plan))], plan.chainId)),
            approve: async (id, plan) => { await request(record, 'evm_crossmintApprove', [id, Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(plan))], plan.chainId) },
            status: async id => Schema.decodeUnknownSync(SmartTransaction)(await request(record, 'evm_crossmintStatus', [id], record.chains[0] ?? 8453)),
          } : undefined,
          request: (method, params, chainId) => request(record, method, params, chainId),
          send: async (plan, nonce) => {
            const tx = { from: plan.account, to: plan.to, data: plan.data, value: numberToHex(BigInt(plan.value)), nonce: numberToHex(nonce), gas: numberToHex(BigInt(plan.gas)), chainId: numberToHex(plan.chainId), ...(plan.feeType === 'eip1559' ? { maxFeePerGas: numberToHex(BigInt(plan.gasPrice)), maxPriorityFeePerGas: numberToHex(BigInt(plan.maxPriorityFeePerGas ?? '0')) } : { gasPrice: numberToHex(BigInt(plan.gasPrice)) }) }
            return decodeWalletHash(await request(record, 'eth_sendTransaction', [Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stringify(tx))], plan.chainId))
          },
        } satisfies ExternalSigner
      })),
    })
  }))
}
