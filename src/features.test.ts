import WebSocket from 'ws'
import { test, expect } from 'bun:test'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { encodeFunctionData, erc20Abi } from 'viem'
import { Plan } from './model'
import { Policy, reservePolicy, savePolicy, revokePolicy } from './policy'
import { storeLayer } from './storage'
import { Socket, SocketInput, socketLayer } from './socket'
import { startBrowserWallet } from './browser-wallet'
import { units } from './assets'

const account = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const hash = `0x${'a'.repeat(64)}`
const base = Schema.decodeUnknownSync(Plan)({ id: 'first', key: 'first', chainId: 31337, account, to: account, data: '0x', value: '6', intentHash: hash, fingerprint: hash, createdAt: 0, expiresAt: Date.now() + 60000, simulationBlock: '1', gas: '21000', gasPrice: '1', policy: 'session' })
const policy: Policy = { name: 'session', account, chains: [31337], expiresAt: Date.now() + 600000, maxFeeWei: '100000', nativeBudgetWei: '10', contracts: [{ address: token, selectors: ['0xa9059cbb', '0x095ea7b3'] }], tokenBudgets: [{ token, amount: '10' }], recipients: [account], revoked: false }

test('policy budgets reserve atomically, do not double-charge retries, and obey revocation', async () => {
  const runtime = ManagedRuntime.make(storeLayer(':memory:'))
  try {
    await runtime.runPromise(savePolicy(policy))
    await runtime.runPromise(reservePolicy(base))
    await runtime.runPromise(reservePolicy(base))
    const exceeded = await runtime.runPromise(reservePolicy({ ...base, id: 'second' }).pipe(Effect.result))
    expect(exceeded._tag).toBe('Failure')
    await runtime.runPromise(revokePolicy('session'))
    expect((await runtime.runPromise(reservePolicy(base).pipe(Effect.result)))._tag).toBe('Failure')
  } finally { await runtime.dispose() }
})
test('token allowances and transfers share a conservative spending budget', async () => {
  const runtime = ManagedRuntime.make(storeLayer(':memory:'))
  try {
    await runtime.runPromise(savePolicy(policy))
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [account, 8n] })
    await runtime.runPromise(reservePolicy({ ...base, value: '0', to: token, data }))
    const spend = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [account, 3n] })
    expect((await runtime.runPromise(reservePolicy({ ...base, id: 'transfer', value: '0', to: token, data: spend }).pipe(Effect.result)))._tag).toBe('Failure')
    expect((await runtime.runPromise(savePolicy(policy).pipe(Effect.result)))._tag).toBe('Failure')
  } finally { await runtime.dispose() }
})
test('units rejects silent fractional rounding', async () => {
  expect(await Effect.runPromise(units({ amount: '1.25', decimals: 6 }))).toEqual({ baseUnits: '1250000', decimal: '1.25', decimals: 6 })
  expect((await Effect.runPromise(units({ amount: '1.0000001', decimals: 6 }).pipe(Effect.result)))._tag).toBe('Failure')
})
test('Socket validates echoed intent and expires routes without requiring credentials', async () => {
  const input: SocketInput = { originChainId: 31337, destinationChainId: 8453, inputToken: token, outputToken: token, inputAmount: '10', userAddress: account, receiverAddress: account, slippage: 0.5 }
  let recipient = account
  let expiresAt = Date.now() / 1000 + 60
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    expect(request.headers.get('x-api-key')).toBeNull()
    expect(new URL(request.url).searchParams.get('userOps')).toBe('tx')
    return Response.json({ success: true, result: { ...input, receiverAddress: recipient, input: { token: { address: token, chainId: 31337, symbol: 'TEST', decimals: 18 }, amount: '10' }, routes: [{ quoteId: 'quote', expiresAt, output: { token: { address: token, chainId: 8453, symbol: 'TEST', decimals: 18 }, amount: '9', minAmountOut: '8' }, txData: { kind: 'evm_tx', object: { chainId: 31337, to: token, data: '0x', value: '0' } }, routeTags: ['SUGGESTED'], estimatedTime: 10 }] } })
  } })
  const run = () => Effect.runPromise(Effect.gen(function* () { return yield* (yield* Socket).quote(input) }).pipe(Effect.provide(socketLayer({ socketUrl: server.url.toString() })), Effect.result))
  try {
    expect((await run())._tag).toBe('Success')
    recipient = token; expect((await run())._tag).toBe('Failure')
    recipient = account; expiresAt = 1; expect((await run())._tag).toBe('Failure')
  } finally { await server.stop(true) }
})
test('browser bridge rejects cross-origin access and binds responses to the pending request', async () => {
  const bridge = startBrowserWallet(31337, account)
  const url = new URL(bridge.url)
  let socket: WebSocket | undefined
  try {
    const forbidden = await fetch(`${url.origin}/bridge`, { headers: { origin: 'https://untrusted.invalid' } })
    expect(forbidden.status).toBe(403)
    socket = new WebSocket(`${url.origin.replace('http:', 'ws:')}/bridge`, { headers: { Origin: url.origin } })
    const opened = Promise.withResolvers<void>()
    socket.onopen = () => opened.resolve()
    await opened.promise
    const ready = Promise.withResolvers<void>()
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.kind === 'ready') ready.resolve() }
    socket.send(JSON.stringify({ kind: 'auth', token: url.hash.slice(1) })); await ready.promise
    socket.send(JSON.stringify({ kind: 'connected', address: account, peer: 'Test wallet' }))
    expect((await bridge.connected).address).toBe(account)
    const current = socket
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.kind === 'request') current.send(JSON.stringify({ kind: 'result', id: message.id, result: hash })) }
    expect(await bridge.request('eth_sendTransaction', [], 31337)).toBe(hash)
  } finally { socket?.close(); bridge.stop() }
})

test('hosted smart-wallet pairing accepts only its configured origin and expected account', async () => {
  const bridge = startBrowserWallet(84532, account, 'https://beegreat.app/evm-wallet')
  const hosted = new URL(bridge.url)
  const local = `http://127.0.0.1:${hosted.searchParams.get('bridgePort')}`
  let socket: WebSocket | undefined
  try {
    expect(hosted.origin).toBe('https://beegreat.app')
    expect((await fetch(`${local}/bridge`, { headers: { origin: 'https://beegreat.app.attacker.invalid', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    socket = new WebSocket(`${local.replace('http:', 'ws:')}/bridge`, { headers: { origin: hosted.origin } })
    const opened = Promise.withResolvers<void>()
    socket.onopen = () => opened.resolve(); await opened.promise
    const ready = Promise.withResolvers<void>()
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.kind === 'ready') { expect(message.expected).toBe(account); expect(message.chainId).toBe(84532); ready.resolve() } }
    socket.send(JSON.stringify({ kind: 'auth', token: hosted.hash.slice(1) })); await ready.promise
    socket.send(JSON.stringify({ kind: 'connected', address: token, peer: 'Wrong wallet' }))
    await expect(bridge.connected).rejects.toThrow()
  } finally { socket?.close(); bridge.stop() }
})
