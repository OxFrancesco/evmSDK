/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Browser providers and websocket messages are untrusted runtime boundaries, narrowed before use. */
import type { BridgeMessage, BrowserTransaction } from './browser-wallet-protocol'

export type BrowserProvider = {
  request: (args: { method: string; params?: readonly object[] }) => Promise<unknown>
  on: (event: string, listener: (value: unknown) => void) => void
  removeListener: (event: string, listener: (value: unknown) => void) => void
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isBrowserProvider(value: unknown): value is BrowserProvider {
  return object(value) && typeof value.request === 'function' && typeof value.on === 'function' && typeof value.removeListener === 'function'
}

function account(value: unknown): string {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value[0])) throw new Error('Unlock your wallet and select an account.')
  return value[0]
}

export function walletError(value: unknown): string {
  return object(value) && typeof value.message === 'string' ? value.message.slice(0, 500) : 'The wallet request failed. Try again.'
}

async function ensureChain(provider: BrowserProvider, chainId: number): Promise<void> {
  const chain = `0x${chainId.toString(16)}`
  if (await provider.request({ method: 'eth_chainId' }) !== chain) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain }] })
  }
  if (await provider.request({ method: 'eth_chainId' }) !== chain) throw new Error('The wallet is on a different network. Switch networks and try again.')
}

class BrowserNotSubmittedError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

export async function sendBrowserTransaction(provider: BrowserProvider, transaction: BrowserTransaction, chainId: number, isConnected: () => boolean): Promise<string> {
  try {
    await ensureChain(provider, chainId)
    const selected = account(await provider.request({ method: 'eth_accounts' }))
    if (selected.toLowerCase() !== transaction.from.toLowerCase()) throw new Error('The wallet account changed. Reconnect and review the transaction again.')
    const chain = `0x${chainId.toString(16)}`
    if (await provider.request({ method: 'eth_chainId' }) !== chain) throw new Error('The wallet network changed. Review the transaction again.')
    if (!isConnected()) throw new Error('Aero disconnected. The transaction was not requested.')
  } catch (cause) { throw new BrowserNotSubmittedError(walletError(cause)) }
  const chain = `0x${chainId.toString(16)}`
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...transaction, chainId: chain }] }).catch((cause: unknown) => {
    if (object(cause) && (cause.code === 4001 || cause.code === 5000)) throw new BrowserNotSubmittedError(walletError(cause), cause.code)
    throw cause
  })
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('The wallet returned an invalid transaction hash. Check wallet activity before retrying.')
  return hash
}

function bridgeMessage(value: unknown): value is BridgeMessage {
  if (!object(value)) return false
  if (value.kind === 'disconnect') return typeof value.message === 'string'
  if (!Number.isSafeInteger(value.chainId) || Number(value.chainId) <= 0) return false
  if (value.kind === 'ready') return value.expectedAddress === undefined || (typeof value.expectedAddress === 'string' && /^0x[0-9a-f]{40}$/i.test(value.expectedAddress))
  if (value.kind !== 'transaction' || typeof value.id !== 'string' || !object(value.transaction)) return false
  const tx = value.transaction
  return typeof tx.from === 'string' && /^0x[0-9a-f]{40}$/i.test(tx.from)
    && typeof tx.to === 'string' && /^0x[0-9a-f]{40}$/i.test(tx.to)
    && typeof tx.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(tx.data)
    && typeof tx.value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(tx.value)
}

export function startBrowserWalletPage(): void {
  const element = (id: string) => {
    const result = document.getElementById(id)
    if (!result) throw new Error(`Missing element: ${id}`)
    return result
  }
  const heading = element('heading'), status = element('status'), wallets = element('wallets')
  const error = element('error'), disconnect = element('disconnect'), retry = element('retry')
  const token = location.hash.slice(1)
  history.replaceState(null, '', location.pathname)
  if (!/^[0-9a-f]{64}$/.test(token)) {
    status.textContent = 'Open a new connection from Aero to use this page.'
    return
  }
  const socket = new WebSocket(`ws://${location.host}/bridge`)
  const providers = new Map<string, { name: string; provider: BrowserProvider }>()
  let ready: Extract<BridgeMessage, { kind: 'ready' }> | undefined
  let chosen: BrowserProvider | undefined
  let selectedAddress: string | undefined
  let busy = false
  let ended = false
  const seenRequests = new Set<string>()
  const showError = (cause: unknown) => { error.textContent = walletError(cause); error.hidden = false }
  const finish = (message: string) => {
    if (ended) return
    ended = true
    if (chosen) {
      chosen.removeListener('accountsChanged', accountsChanged)
      chosen.removeListener('disconnect', walletDisconnected)
    }
    heading.textContent = 'Wallet disconnected'
    status.textContent = busy && chosen ? `${message} Cancel any pending approval in your wallet.` : message
    wallets.replaceChildren()
    disconnect.hidden = true
    retry.hidden = true
    socket.close(1000)
  }
  const detach = (message: string) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'disconnect' }))
    finish(message)
  }
  const accountsChanged = (value: unknown) => {
    try { if (account(value).toLowerCase() === selectedAddress?.toLowerCase()) return } catch { /* Locked or empty account list ends the authorization. */ }
    detach('Your wallet account changed. Reconnect from Aero before sending another transaction.')
  }
  const walletDisconnected = () => detach('Your wallet disconnected. Reconnect from Aero to continue.')
  const render = () => {
    if (!ready || chosen || busy || ended) return
    wallets.replaceChildren()
    retry.hidden = providers.size > 0
    status.textContent = providers.size ? 'Choose the wallet you want to use with Aero.' : 'No browser wallet found. Enable Rabby in this browser, then try again.'
    for (const [id, entry] of [...providers].sort(([a], [b]) => Number(b === 'io.rabby') - Number(a === 'io.rabby'))) {
      const button = document.createElement('button')
      button.textContent = `Connect ${entry.name}`
      if (id === 'io.rabby') button.className = 'primary'
      button.onclick = () => { void connect(entry) }
      wallets.append(button)
    }
  }
  const connect = async (entry: { name: string; provider: BrowserProvider }) => {
    if (!ready || busy || ended) return
    busy = true
    error.hidden = true
    wallets.querySelectorAll('button').forEach((button) => { button.disabled = true })
    status.textContent = `Approve the connection in ${entry.name}.`
    try {
      const address = account(await entry.provider.request({ method: 'eth_requestAccounts' }))
      if (ready.expectedAddress && address.toLowerCase() !== ready.expectedAddress.toLowerCase()) throw new Error(`Select ${ready.expectedAddress} in your wallet, then try again.`)
      await ensureChain(entry.provider, ready.chainId)
      if (account(await entry.provider.request({ method: 'eth_accounts' })).toLowerCase() !== address.toLowerCase()) throw new Error('The wallet account changed. Try connecting again.')
      if (ended || socket.readyState !== WebSocket.OPEN) return
      chosen = entry.provider
      selectedAddress = address
      chosen.on('accountsChanged', accountsChanged)
      chosen.on('disconnect', walletDisconnected)
      socket.send(JSON.stringify({ kind: 'connected', address, peer: entry.name }))
      wallets.replaceChildren()
      retry.hidden = true
      heading.textContent = 'Wallet connected'
      element('peer').textContent = entry.name
      element('address').textContent = address
      element('account').hidden = false
      status.textContent = 'Keep this tab open. Continue in Aero and approve transactions in your wallet.'
      disconnect.hidden = false
    } catch (cause) { showError(cause) }
    finally { busy = false; render() }
  }
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (!(event instanceof CustomEvent)) return
    const detail: unknown = event.detail
    if (!object(detail) || !object(detail.info) || !isBrowserProvider(detail.provider)) return
    const { rdns, name } = detail.info
    if (typeof rdns !== 'string' || typeof name !== 'string' || !name.trim() || providers.has(rdns)) return
    providers.set(rdns, { name: name.slice(0, 120), provider: detail.provider })
    render()
  })
  retry.onclick = () => { window.dispatchEvent(new Event('eip6963:requestProvider')); render() }
  disconnect.onclick = () => detach('Disconnected from Aero. You can close this tab.')
  socket.onopen = () => socket.send(JSON.stringify({ kind: 'authenticate', token }))
  socket.onclose = () => finish('Aero closed the connection. Reconnect from Aero to continue.')
  socket.onerror = () => finish('Cannot reach Aero. Open a new connection from the terminal.')
  socket.onmessage = async (event) => {
    let message: unknown
    try { message = JSON.parse(String(event.data)) } catch { return finish('Aero sent an invalid request.') }
    if (!bridgeMessage(message)) return finish('Aero sent an invalid request.')
    if (message.kind === 'disconnect') return finish(message.message)
    if (message.kind === 'ready') {
      ready = message
      window.dispatchEvent(new Event('eip6963:requestProvider'))
      render()
      return
    }
    if (!chosen || ended || seenRequests.has(message.id)) return
    seenRequests.add(message.id)
    if (busy) {
      socket.send(JSON.stringify({ kind: 'error', id: message.id, message: 'Another wallet request is pending.', notSubmitted: true }))
      return
    }
    busy = true
    error.hidden = true
    status.textContent = 'Review and approve the transaction in your wallet.'
    try {
      if (message.transaction.from.toLowerCase() !== selectedAddress?.toLowerCase()) throw new BrowserNotSubmittedError('Transaction sender differs from the connected account.')
      const hash = await sendBrowserTransaction(chosen, message.transaction, message.chainId, () => !ended && socket.readyState === WebSocket.OPEN)
      if (ended) return
      socket.send(JSON.stringify({ kind: 'result', id: message.id, hash }))
      status.textContent = 'Transaction submitted. Check confirmation in Aero.'
    } catch (cause) {
      if (ended) return
      socket.send(JSON.stringify({ kind: 'error', id: message.id, message: walletError(cause), notSubmitted: cause instanceof BrowserNotSubmittedError }))
      showError(cause)
      status.textContent = 'Continue in Aero to review the result.'
    } finally { busy = false }
  }
}

if (typeof window !== 'undefined') startBrowserWalletPage()
