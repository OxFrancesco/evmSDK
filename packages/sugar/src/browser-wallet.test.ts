import { afterEach, describe, expect, test } from 'bun:test'
import * as Schema from 'effect/Schema'
import { startBrowserWalletBridge } from './browser-wallet'
import { sendBrowserTransaction, type BrowserProvider } from './browser-wallet-client'
import type { UnsignedTransaction } from './types'

const address = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const hash: `0x${string}` = `0x${'ab'.repeat(32)}`
const transaction: UnsignedTransaction = { from: address, to: other, data: '0x1234', value: 15n }
const bridges: ReturnType<typeof startBrowserWalletBridge>[] = []
const clients: WebSocket[] = []

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop()
  for (const client of clients.splice(0)) client.close()
})

function bridge(options: Partial<Parameters<typeof startBrowserWalletBridge>[0]> = {}) {
  const server = startBrowserWalletBridge({ chainId: 8453, ...options })
  bridges.push(server)
  return server
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    client.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
    client.addEventListener('close', () => reject(new Error('Socket closed')), { once: true })
  })
}

async function peer(server: ReturnType<typeof bridge>, origin?: string) {
  const url = new URL(server.url)
  // @ts-expect-error Bun's WebSocket client accepts headers; the DOM constructor typings omit that overload.
  const client = new WebSocket(`ws://${url.host}/bridge`, { headers: { Origin: origin ?? url.origin } })
  clients.push(client)
  await new Promise<void>((resolve, reject) => {
    client.addEventListener('open', () => resolve(), { once: true })
    client.addEventListener('error', () => reject(new Error('Upgrade rejected')), { once: true })
  })
  return client
}

async function authorize(server: ReturnType<typeof bridge>) {
  const client = await peer(server)
  const response = nextMessage(client)
  client.send(JSON.stringify({ kind: 'authenticate', token: new URL(server.url).hash.slice(1) }))
  expect(JSON.parse(await response)).toMatchObject({ kind: 'ready', chainId: 8453 })
  client.send(JSON.stringify({ kind: 'connected', address, peer: 'Test browser wallet' }))
  expect(await server.connected).toMatchObject({ address, peer: 'Test browser wallet' })
  return client
}

describe('loopback browser wallet bridge', () => {
  test('serves embedded assets with restrictive headers and no token in the page', async () => {
    const server = bridge()
    const url = new URL(server.url)
    const response = await fetch(url.origin)
    const page = await response.text()
    expect(response.status).toBe(200)
    expect(page).toContain('Connect a browser wallet')
    expect(page).not.toContain(url.hash.slice(1))
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
    const script = await fetch(`${url.origin}/wallet.js`)
    expect(script.headers.get('content-type')).toContain('text/javascript')
    expect(await script.text()).toContain('eip6963:requestProvider')
    expect((await fetch(url.origin, { method: 'POST' })).status).toBe(405)
    expect((await fetch(url.origin, { headers: { Host: 'attacker.example' } })).status).toBe(403)
    expect((await fetch(url.origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
  })

  test('rejects cross-origin websocket upgrades', async () => {
    await expect(peer(bridge(), 'https://attacker.example')).rejects.toThrow('Upgrade rejected')
  })

  test('rejects missing and incorrect authentication', async () => {
    const server = bridge()
    for (const message of [{ kind: 'connected', address, peer: 'Test' }, { kind: 'authenticate', token: 'wrong' }]) {
      const client = await peer(server)
      const closed = new Promise((resolve) => client.addEventListener('close', (event) => resolve(event.code), { once: true }))
      client.send(JSON.stringify(message))
      expect(await closed).toBe(1008)
    }
    expect(server.isConnected()).toBe(false)
  })

  test('rejects another tab after claiming a session', async () => {
    const server = bridge()
    await authorize(server)
    await expect(peer(server)).rejects.toThrow('Upgrade rejected')
  })

  test('forwards exact reviewed calldata and resolves the matching hash', async () => {
    const server = bridge()
    const client = await authorize(server)
    const request = nextMessage(client)
    const result = server.sendTransaction(transaction, 8453)
    const raw = await request
    expect(JSON.parse(raw)).toMatchObject({ kind: 'transaction', chainId: 8453, transaction: { from: address, to: other, data: '0x1234', value: '0xf' } })
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(JSON.parse(raw))
    client.send(JSON.stringify({ kind: 'result', id: 'unrelated', hash }))
    client.send(JSON.stringify({ kind: 'result', id, hash }))
    expect(await result).toBe(hash)
  })

  test('rejects sender, chain and concurrent-request mismatches', async () => {
    const server = bridge()
    const client = await authorize(server)
    await expect(server.sendTransaction({ ...transaction, from: other }, 8453)).rejects.toThrow('reviewed sender')
    await expect(server.sendTransaction(transaction, 1)).rejects.toThrow('Unsupported')
    const request = nextMessage(client)
    const result = server.sendTransaction(transaction, 8453)
    await expect(server.sendTransaction(transaction, 8453)).rejects.toThrow('already pending')
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(JSON.parse(await request))
    client.send(JSON.stringify({ kind: 'error', id, message: 'User rejected the request.' }))
    await expect(result).rejects.toThrow('User rejected')
  })

  test('closing a tab rejects an in-flight transaction without replay', async () => {
    const server = bridge()
    const client = await authorize(server)
    const request = nextMessage(client)
    const result = server.sendTransaction(transaction, 8453)
    const rejected = result.catch((error: Error) => error.message)
    await request
    client.close(1000)
    expect(await rejected).toContain('may have been submitted')
    expect(server.isConnected()).toBe(false)
  })

  test('explicit disconnect notifies the owner and closes the listener', async () => {
    let disconnected = false
    const server = bridge({ onDisconnect: () => { disconnected = true } })
    const client = await authorize(server)
    const closed = new Promise((resolve) => client.addEventListener('close', resolve, { once: true }))
    client.send(JSON.stringify({ kind: 'disconnect' }))
    await closed
    expect(disconnected).toBe(true)
    expect(server.isConnected()).toBe(false)
  })

  test('pairing is bounded and cancellable', async () => {
    const expired = bridge({ pairingTimeoutMs: 10 })
    await expect(expired.connected).rejects.toThrow('timed out')
    const controller = new AbortController()
    const cancelled = bridge({ signal: controller.signal })
    controller.abort()
    await expect(cancelled.connected).rejects.toThrow('cancelled')
  })

  test('a timed-out transaction cannot be replayed on the same connection', async () => {
    const server = bridge({ requestTimeoutMs: 10 })
    await authorize(server)
    await expect(server.sendTransaction(transaction, 8453)).rejects.toThrow('may have been submitted')
    await expect(server.sendTransaction(transaction, 8453)).rejects.toThrow('disconnected')
  })

  test('reconnection requires the previously reviewed address', async () => {
    const server = bridge({ expectedAddress: other })
    const client = await peer(server)
    const ready = nextMessage(client)
    client.send(JSON.stringify({ kind: 'authenticate', token: new URL(server.url).hash.slice(1) }))
    await ready
    client.send(JSON.stringify({ kind: 'connected', address, peer: 'Test' }))
    await expect(server.connected).rejects.toThrow('reviewed sender')
  })
})

describe('browser provider transaction checks', () => {
  const tx = { from: address, to: other, data: '0x1234', value: '0xf' }
  function provider(options: { selected?: string; refusesChain?: boolean; rejected?: boolean; invalidHash?: boolean; afterSwitch?: () => void } = {}) {
    let chain = '0x1'
    const calls: { method: string; params?: readonly object[] }[] = []
    const wallet: BrowserProvider = {
      on() {}, removeListener() {},
      async request(args) {
        calls.push(args)
        switch (args.method) {
          case 'eth_chainId': return chain
          case 'eth_accounts': return [options.selected ?? address]
          case 'wallet_switchEthereumChain':
            if (!options.refusesChain) chain = '0x2105'
            options.afterSwitch?.()
            return null
          case 'eth_sendTransaction':
            if (options.rejected) throw { code: 4001, message: 'User rejected the request.' }
            return options.invalidHash ? 'invalid' : hash
          default: throw new Error(`Unexpected wallet method: ${args.method}`)
        }
      },
    }
    return { wallet, calls }
  }

  test('switches network, rechecks account and forwards exact transaction', async () => {
    const { wallet, calls } = provider()
    expect(await sendBrowserTransaction(wallet, tx, 8453, () => true)).toBe(hash)
    expect(calls.map((call) => call.method)).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction'])
    expect(calls.at(-1)?.params).toEqual([{ ...tx, chainId: '0x2105' }])
  })

  test('never requests a transaction after account change or refused network switch', async () => {
    for (const options of [{ selected: other }, { refusesChain: true }]) {
      const { wallet, calls } = provider(options)
      await expect(sendBrowserTransaction(wallet, tx, 8453, () => true)).rejects.toThrow()
      expect(calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false)
    }
  })

  test('disconnect during a network switch prevents the send', async () => {
    let connected = true
    const { wallet, calls } = provider({ afterSwitch: () => { connected = false } })
    await expect(sendBrowserTransaction(wallet, tx, 8453, () => connected)).rejects.toThrow('disconnected')
    expect(calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false)
  })

  test('preserves wallet rejection and rejects malformed hashes', async () => {
    await expect(sendBrowserTransaction(provider({ rejected: true }).wallet, tx, 8453, () => true)).rejects.toMatchObject({ code: 4001 })
    await expect(sendBrowserTransaction(provider({ invalidHash: true }).wallet, tx, 8453, () => true)).rejects.toThrow('invalid transaction hash')
  })
})
