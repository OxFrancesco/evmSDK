import { TransactionNotSubmittedError } from './submission-error'
import { randomBytes } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import * as Schema from 'effect/Schema'
import { getAddress, type Address, type Hex } from 'viem'
import { isSupportedChainId } from './config'
import { browserMessageSchema, browserTransactionSchema, type BridgeMessage, type BrowserWalletRecord } from './browser-wallet-protocol'
import { constantTimeEquals, deleteBrowserWalletRecord, loadBrowserWalletRecord, onWalletChange, saveBrowserWalletRecord } from './wallet'
import type { UnsignedTransaction } from './types'
import html from './browser-wallet.html.txt' with { type: 'text' }
// @ts-expect-error Bun's text loader imports TypeScript source as a string, not as an executable module.
import clientSource from './browser-wallet-client.ts' with { type: 'text' }

type SocketData = { authenticated: boolean; timer: ReturnType<typeof setTimeout> }
type PendingTransaction = { id: string; resolve: (hash: Hex) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type BridgeOptions = {
  chainId: number
  expectedAddress?: Address
  signal?: AbortSignal
  pairingTimeoutMs?: number
  requestTimeoutMs?: number
  onDisconnect?: () => void
}

const browserScript = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(clientSource)

export function startBrowserWalletBridge(options: BridgeOptions) {
  if (!isSupportedChainId(options.chainId)) throw new Error('Unsupported browser wallet chain')
  options.signal?.throwIfAborted()
  const token = randomBytes(32).toString('hex')
  let socket: ServerWebSocket<SocketData> | undefined
  let identity: BrowserWalletRecord | undefined
  let pending: PendingTransaction | undefined
  let stopped = false
  const connected = Promise.withResolvers<BrowserWalletRecord>()
  const closed = Promise.withResolvers<void>()
  // The caller can still be opening the browser when cancellation arrives.
  void connected.promise.catch(() => {})
  const sockets = new Set<ServerWebSocket<SocketData>>()
  const headers = {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  const send = (message: BridgeMessage) => socket?.send(JSON.stringify(message))
  const stop = (message = 'Aero closed the connection. You can close this tab.') => {
    if (stopped) return
    stopped = true
    clearTimeout(pairingTimer)
    options.signal?.removeEventListener('abort', abort)
    const error = new Error(pending ? `${message} A transaction may have been submitted. Check wallet activity before retrying.` : message)
    connected.reject(error)
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
    send({ kind: 'disconnect', message })
    for (const client of sockets) { clearTimeout(client.data.timer); client.close(1000, 'Disconnected') }
    socket = undefined
    void server.stop(true)
    closed.resolve()
  }
  const abort = () => stop('Browser wallet connection cancelled.')
  const pairingTimer = setTimeout(() => stop('Browser wallet connection timed out. Connect again from Aero.'), options.pairingTimeoutMs ?? 120_000)
  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 8192,
    fetch(request, server) {
      const url = new URL(request.url)
      const host = `127.0.0.1:${server.port}`
      if (url.host !== host || request.headers.get('host') !== host) return new Response('Forbidden', { status: 403 })
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      if (url.pathname === '/bridge') {
        if (request.headers.get('origin') !== `http://${host}` || stopped || socket || sockets.size >= 4) return new Response('Forbidden', { status: 403 })
        const timer = setTimeout(() => {
          for (const client of sockets) if (client.data.timer === timer && !client.data.authenticated) client.close(1008, 'Authentication required')
        }, 5000)
        if (server.upgrade(request, { data: { authenticated: false, timer } })) return
        clearTimeout(timer)
        return new Response('WebSocket required', { status: 400 })
      }
      if (request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Forbidden', { status: 403 })
      if (url.pathname === '/') return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } })
      if (url.pathname === '/wallet.js') return new Response(browserScript, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } })
      return new Response('Not found', { status: 404, headers })
    },
    websocket: {
      maxPayloadLength: 8192, idleTimeout: 30, sendPings: true,
      open(client) { sockets.add(client) },
      message(client, raw) {
        try {
          const message = Schema.decodeUnknownSync(browserMessageSchema)(JSON.parse(String(raw)))
          if (!client.data.authenticated) {
            if (message.kind !== 'authenticate' || !constantTimeEquals(message.token, token) || socket) return client.close(1008, 'Unauthorized')
            clearTimeout(client.data.timer)
            client.data.authenticated = true
            socket = client
            send({ kind: 'ready', chainId: options.chainId, expectedAddress: options.expectedAddress })
            return
          }
          if (client !== socket || stopped) return
          switch (message.kind) {
            case 'authenticate': return client.close(1008, 'Already authenticated')
            case 'connected': {
              if (identity) return client.close(1008, 'Already connected')
              const address = getAddress(message.address)
              if (options.expectedAddress && address !== getAddress(options.expectedAddress)) return stop('The browser account differs from the reviewed sender. Reconnect the expected account.')
              identity = { version: 1, address, peer: message.peer }
              clearTimeout(pairingTimer)
              connected.resolve(identity)
              return
            }
            case 'disconnect':
              options.onDisconnect?.()
              return stop('Wallet disconnected. Reconnect from Aero to continue.')
            case 'result':
            case 'error': {
              if (!pending || message.id !== pending.id) return
              const request = pending
              pending = undefined
              clearTimeout(request.timer)
              if (message.kind === 'error') request.reject(message.notSubmitted === true ? new TransactionNotSubmittedError(message.message) : new Error(message.message))
              else request.resolve(`0x${message.hash.slice(2)}`)
              return
            }
          }
        } catch { client.close(1008, 'Invalid message') }
      },
      close(client) {
        clearTimeout(client.data.timer)
        sockets.delete(client)
        if (client === socket) stop('The browser tab closed or lost its connection. Reconnect from Aero.')
      },
    },
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  return {
    url: `http://127.0.0.1:${server.port}/#${token}`,
    connected: connected.promise,
    closed: closed.promise,
    isConnected: () => !stopped && identity !== undefined && socket !== undefined,
    stop,
    async sendTransaction(transaction: UnsignedTransaction, chainId: number): Promise<Hex> {
      if (!identity || !socket || stopped) throw new TransactionNotSubmittedError('Browser wallet disconnected; reconnect from Aero')
      if (pending) throw new TransactionNotSubmittedError('A browser wallet transaction is already pending')
      if (!isSupportedChainId(chainId)) throw new TransactionNotSubmittedError('Unsupported browser wallet chain')
      if (getAddress(transaction.from) !== getAddress(identity.address)) throw new TransactionNotSubmittedError('Browser wallet account differs from the reviewed sender')
      const payload = Schema.decodeUnknownSync(browserTransactionSchema)({
        from: transaction.from, to: transaction.to, data: transaction.data, value: `0x${transaction.value.toString(16)}`,
      })
      return new Promise<Hex>((resolve, reject) => {
        const id = crypto.randomUUID()
        pending = { id, resolve, reject, timer: setTimeout(() => stop('Wallet approval timed out.'), options.requestTimeoutMs ?? 300_000) }
        send({ kind: 'transaction', id, chainId, transaction: payload })
      })
    },
  }
}

let activeBridge: ReturnType<typeof startBrowserWalletBridge> | undefined

export function stopBrowserWallet(): void {
  activeBridge?.stop()
  activeBridge = undefined
}

export function disconnectBrowserWallet(): boolean {
  stopBrowserWallet()
  return deleteBrowserWalletRecord()
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url]
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  if (await child.exited !== 0) throw new Error('Could not open the browser')
}

export async function connectBrowserWallet(log: (line: string) => void = console.log, chainId = 8453, signal?: AbortSignal, expectedAddress?: Address): Promise<BrowserWalletRecord> {
  stopBrowserWallet()
  const bridge = startBrowserWalletBridge({ chainId, signal, expectedAddress, onDisconnect: () => { deleteBrowserWalletRecord() } })
  activeBridge = bridge
  log('Opening the browser. Select Rabby and approve the connection.')
  log(`If your wallet is in another browser, open this link there:\n${bridge.url}`)
  try {
    try { await openBrowser(bridge.url) } catch { log('Open the link above in the browser where your wallet is installed.') }
    const record = await bridge.connected
    const { disconnectWalletConnect } = await import('./walletconnect')
    await disconnectWalletConnect()
    if (!bridge.isConnected()) throw new Error('Browser wallet disconnected before the connection completed')
    saveBrowserWalletRecord(record)
    const unwatch = onWalletChange(() => {
      const selected = loadBrowserWalletRecord()
      if (!selected || selected.address !== record.address || selected.peer !== record.peer) bridge.stop('The selected wallet changed in Aero. Reconnect to continue.')
    })
    void bridge.closed.then(unwatch)
    return record
  } catch (cause) {
    bridge.stop()
    if (activeBridge === bridge) activeBridge = undefined
    throw cause
  }
}

export async function browserWalletSendTransaction(transaction: UnsignedTransaction, chainId: number, log: (line: string) => void = console.log): Promise<Hex> {
  const { record, bridge } = await (async () => {
    try {
      const record = loadBrowserWalletRecord()
      if (!record) throw new Error('No browser wallet selected; run: aero wallet connect --browser')
      if (getAddress(transaction.from) !== getAddress(record.address)) throw new Error('Browser wallet account differs from the reviewed sender')
      if (!activeBridge?.isConnected()) await connectBrowserWallet(log, chainId, undefined, getAddress(record.address))
      const bridge = activeBridge
      if (!bridge) throw new Error('Browser wallet disconnected')
      return { record, bridge }
    } catch (cause) {
      throw new TransactionNotSubmittedError(cause instanceof Error ? cause.message : 'Browser wallet is unavailable before submission', { cause })
    }
  })()
  log(`Approve the transaction in ${record.peer}.`)
  return bridge.sendTransaction(transaction, chainId)
}
