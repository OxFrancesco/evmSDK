import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { Schema } from 'effect'
import { Address, ChainId, Hash } from './model'
import html from './wallet.html.txt' with { type: 'text' }
import script from './wallet-browser.js.txt' with { type: 'text' }

const Message = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('auth'), token: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('connected'), address: Address, peer: Schema.String.check(Schema.isMaxLength(120)) }),
  Schema.Struct({ kind: Schema.Literal('result'), id: Schema.String, result: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal('error'), id: Schema.String, message: Schema.String.check(Schema.isMaxLength(500)), rejected: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('disconnect') }),
])
export class WalletRejected extends Error {}
interface ClientData { authenticated: boolean }
interface Pending { id: string; resolve: (result: Schema.Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export function startBrowserWallet(chainId: number, expected?: string, hostedUrl?: string) {
  Schema.decodeUnknownSync(ChainId)(chainId)
  const token = randomBytes(32).toString('hex')
  const hosted = hostedUrl ? new URL(hostedUrl) : undefined
  if (hosted && hosted.protocol !== 'https:' && !(hosted.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hosted.hostname))) throw new Error('Smart wallet page must use HTTPS or local development.')
  const connected = Promise.withResolvers<{ address: Schema.Schema.Type<typeof Address>; peer: string }>()
  void connected.promise.catch(() => {})
  let socket: ServerWebSocket<ClientData> | undefined
  const clients = new Set<ServerWebSocket<ClientData>>()
  let identity: { address: Schema.Schema.Type<typeof Address>; peer: string } | undefined
  let pending: Pending | undefined
  let ended = false
  const stop = () => {
    if (ended) return
    ended = true
    clearTimeout(pairing)
    connected.reject(new Error('Wallet connection closed.'))
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Wallet submission may be unresolved. Reconcile before retrying.')); pending = undefined }
    for (const client of clients) client.close()
    void server.stop(true)
  }
  const pairing = setTimeout(stop, hosted ? 600000 : 120000)
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
  const server = Bun.serve<ClientData>({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024,
    fetch(request, server) {
      const host = `127.0.0.1:${server.port}`
      const url = new URL(request.url)
      const allowedOrigin = hosted?.origin ?? `http://${host}`
      if (request.method !== 'GET' || url.host !== host || request.headers.get('host') !== host || request.headers.get('sec-fetch-site') === 'cross-site' && request.headers.get('origin') !== allowedOrigin) return new Response('Forbidden', { status: 403 })
      if (url.pathname === '/bridge') {
        if (request.headers.get('origin') !== allowedOrigin || socket || clients.size >= 4 || ended) return new Response('Forbidden', { status: 403 })
        if (server.upgrade(request, { data: { authenticated: false } })) return
        return new Response('WebSocket required', { status: 400 })
      }
      if (url.pathname === '/') return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html' } })
      if (url.pathname === '/wallet.js') return new Response(script, { headers: { ...headers, 'Content-Type': 'text/javascript' } })
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      maxPayloadLength: 65536, idleTimeout: 30,
      open(client) { clients.add(client) },
      close(client) { clients.delete(client); if (client === socket) stop() },
      message(client, raw) {
        const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Message))(String(raw))
        if (decoded._tag === 'None') return client.close(1008)
        const message = decoded.value
        if (!client.data.authenticated) {
          if (message.kind !== 'auth' || message.token.length !== token.length || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token)) || socket) return client.close(1008)
          socket = client; client.data.authenticated = true
          client.send(JSON.stringify({ kind: 'ready', chainId, expected }))
          return
        }
        if (client !== socket) return client.close(1008)
        if (message.kind === 'connected') {
          if (identity || expected && message.address.toLowerCase() !== expected.toLowerCase()) return stop()
          identity = { address: message.address, peer: message.peer }; clearTimeout(pairing); connected.resolve(identity)
        } else if (message.kind === 'disconnect') stop()
        else if ((message.kind === 'result' || message.kind === 'error') && pending?.id === message.id) {
          const request = pending; pending = undefined; clearTimeout(request.timer)
          if (message.kind === 'result') request.resolve(message.result)
          else request.reject(message.rejected ? new WalletRejected(message.message) : new Error(message.message))
        }
      },
    },
  })
  if (hosted) { hosted.hash = token; hosted.searchParams.set('bridgePort', String(server.port)) }
  return {
    url: hosted?.toString() ?? `http://127.0.0.1:${server.port}/#${token}`, connected: connected.promise, stop,
    isConnected: () => Boolean(identity && socket && !ended),
    request(method: string, params: ReadonlyArray<Schema.Json>, requestChain: number) {
      if (!socket || !identity || ended || pending) return Promise.reject(new WalletRejected('Connect the wallet before requesting a signature.'))
      const account = identity.address
      const id = crypto.randomUUID()
      return new Promise<Schema.Json>((resolve, reject) => {
        pending = { id, resolve, reject, timer: setTimeout(stop, 300000) }
        socket?.send(JSON.stringify({ kind: 'request', id, method, params, chainId: requestChain, account }))
      })
    },
  }
}
export const decodeWalletHash = Schema.decodeUnknownSync(Hash)
