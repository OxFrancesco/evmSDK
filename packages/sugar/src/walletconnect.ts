import { join } from 'node:path'
import * as Schema from 'effect/Schema'
import { normalizeAddress } from './helpers'
import { walletConnectSessionRecord } from './walletconnect-session'
import type { Hex } from 'viem'
import { SUPPORTED_CHAIN_IDS } from './config'
import type { UnsignedTransaction } from './types'
import {
  deleteWalletConnectRecord,
  loadWalletConnectRecord,
  saveWalletConnectRecord,
  walletDir,
  type WalletConnectRecord,
} from './wallet'

/**
 * WalletConnect v2 pairing for the CLI: the QR code (or copied wc: URI) links
 * a browser-extension or mobile wallet, which then signs and broadcasts every
 * transaction itself. The CLI never sees a private key on this path.
 */

const METADATA = {
  name: 'BeeGreat aero CLI (unofficial)',
  description: 'Independent CLI. Not affiliated with or endorsed by Aerodrome Finance, Velodrome Finance, or Dromos Labs.',
  url: 'https://github.com/OxFrancesco/aerodrome-sdk-ts',
  icons: [],
}

type SignClientInstance = Awaited<ReturnType<(typeof import('@walletconnect/sign-client'))['SignClient']['init']>>

/** Reown project ids are public by design; env vars override the default. */
const DEFAULT_PROJECT_ID = 'cebb813303780775ef7c4a93f1daadee'

export function walletConnectProjectId(): string {
  return process.env.WALLETCONNECT_PROJECT_ID ?? process.env.REOWN_PROJECT_ID ?? DEFAULT_PROJECT_ID
}

let sharedClient: Promise<SignClientInstance> | undefined
let invalidatedTopic: string | undefined

function initSignClient(): Promise<SignClientInstance> {
  if (sharedClient) return sharedClient
  sharedClient = import('@walletconnect/sign-client').then(({ SignClient }) => SignClient.init({
    projectId: walletConnectProjectId(), metadata: METADATA,
    storageOptions: { database: join(walletDir(), 'walletconnect') },
  })).then((client) => {
    const clear = ({ topic }: { topic: string }) => {
      if (loadWalletConnectRecord()?.topic === topic) deleteWalletConnectRecord()
      if (invalidatedTopic === topic) invalidatedTopic = undefined
    }
    client.on('session_delete', clear)
    client.on('session_expire', clear)
    client.on('session_update', ({ topic, params }) => {
      const record = loadWalletConnectRecord()
      const session = client.session.getAll().find((entry) => entry.topic === topic)
      if (!record || record.topic !== topic || !session) return
      try { saveWalletConnectRecord(walletConnectSessionRecord({ ...session, namespaces: params.namespaces }, undefined, record.address)) }
      catch { invalidatedTopic = topic; deleteWalletConnectRecord() }
    })
    client.on('session_event', ({ topic, params }) => {
      if (params.event.name === 'accountsChanged' && loadWalletConnectRecord()?.topic === topic) {
        invalidatedTopic = topic
        deleteWalletConnectRecord()
      }
    })
    return client
  }).catch((cause: unknown) => { sharedClient = undefined; throw cause })
  return sharedClient
}

export async function stopWalletConnect(): Promise<void> {
  const pending = sharedClient
  if (!pending) return
  sharedClient = undefined
  const client = await pending
  for (const event of ['session_delete', 'session_expire', 'session_update', 'session_event'] as const) client.removeAllListeners(event)
  await client.core.relayer.transportClose()
}

export async function connectWalletConnect(
  log: (line: string) => void = console.log,
  chainId = 8453,
): Promise<WalletConnectRecord> {
  if (loadWalletConnectRecord() || invalidatedTopic) await disconnectWalletConnect()
  const client = await initSignClient()
  const optionalChains = SUPPORTED_CHAIN_IDS.filter((chain) => chain !== chainId)
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction'],
        chains: [`eip155:${chainId}`],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
    optionalNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction'],
        chains: optionalChains.map((chain) => `eip155:${chain}`),
        events: ['accountsChanged', 'chainChanged'],
      },
    },
  })
  if (!uri) throw new Error('WalletConnect did not produce a pairing URI')
  const { renderUnicodeCompact } = await import('uqr')
  log('Scan with your wallet app, or paste the URI into a WalletConnect-capable extension:\n')
  log(renderUnicodeCompact(uri))
  log(`\n${uri}\n`)
  log('Waiting for wallet approval...')
  const session = await approval()
  const record = walletConnectSessionRecord(session, chainId)
  saveWalletConnectRecord(record)
  return record
}

export async function walletConnectSendTransaction(
  transaction: UnsignedTransaction,
  chainId: number,
  log: (line: string) => void = console.log,
): Promise<Hex> {
  const record = loadWalletConnectRecord()
  if (!record) throw new Error('no WalletConnect session; run: wallet connect')
  const client = await initSignClient()
  const session = client.session.getAll().find((item) => item.topic === record.topic)
  if (!session) {
    deleteWalletConnectRecord()
    throw new Error('the WalletConnect session expired; run: wallet connect')
  }
  if (normalizeAddress(transaction.from) !== normalizeAddress(record.address)) throw new Error('WalletConnect account differs from the reviewed sender')
  const current = walletConnectSessionRecord(session, chainId, transaction.from)
  saveWalletConnectRecord(current)
  log('Approve the transaction in your wallet...')
  const hash = await client.request<unknown>({
    topic: record.topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: 'eth_sendTransaction',
      params: [{
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: `0x${transaction.value.toString(16)}`,
      }],
    },
  })
  const parsed = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/i)))(hash)
  return `0x${parsed.slice(2)}`
}

export async function disconnectWalletConnect(): Promise<boolean> {
  const record = loadWalletConnectRecord()
  const topic = record?.topic ?? invalidatedTopic
  if (!topic) return false
  try {
    const client = await initSignClient()
    await client.disconnect({
      topic,
      reason: { code: 6000, message: 'User disconnected' },
    })
  } catch { /* the relay session may already be gone; local cleanup still applies */ }
  deleteWalletConnectRecord()
  invalidatedTopic = undefined
  return true
}
