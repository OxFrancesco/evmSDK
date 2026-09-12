import { describe, expect, test } from 'bun:test'
import { walletConnectSessionRecord, type WalletConnectSession } from './walletconnect-session'

const alice = '0x1111111111111111111111111111111111111111'
const bob = '0x2222222222222222222222222222222222222222'
const session = (): WalletConnectSession => ({
  topic: 'session-1', expiry: Math.floor(Date.now() / 1_000) + 3_600,
  namespaces: { eip155: { accounts: [`eip155:8453:${alice}`, `eip155:10:${bob}`], methods: ['eth_sendTransaction'], events: [] } },
  peer: { publicKey: 'public-key', metadata: { name: 'Test wallet', description: '', url: 'https://example.com', icons: [] } },
})

describe('WalletConnect account authorization', () => {
  test('preserves chain-specific accounts without authorizing the first address on every chain', () => {
    const record = walletConnectSessionRecord(session(), 8453)
    expect(record).toMatchObject({ version: 2, address: alice, chains: [8453], accounts: [{ chainId: 8453, address: alice }, { chainId: 10, address: bob }] })
    expect(() => walletConnectSessionRecord(session(), 10, alice)).toThrow('does not authorize')
    expect(walletConnectSessionRecord(session(), 10, bob).address).toBe(bob)
  })

  test('rejects revoked methods, expired sessions, malformed accounts and wrong namespace chains', () => {
    const revoked = session()
    revoked.namespaces.eip155.methods = ['personal_sign']
    expect(() => walletConnectSessionRecord(revoked, 8453, alice)).toThrow('does not authorize')
    expect(() => walletConnectSessionRecord({ ...session(), expiry: 1 }, 8453, alice)).toThrow('expired')
    const malformed = session()
    malformed.namespaces.eip155.accounts = ['eip155:8453:bad-address']
    expect(() => walletConnectSessionRecord(malformed, 8453, alice)).toThrow('invalid account')
    const mismatch = session()
    mismatch.namespaces = { 'eip155:10': { ...mismatch.namespaces.eip155, accounts: [`eip155:8453:${alice}`] } }
    expect(() => walletConnectSessionRecord(mismatch, 8453, alice)).toThrow('does not authorize')
  })

  test('honors chain-scoped namespaces and a changed account list', () => {
    const scoped = session()
    scoped.namespaces = { 'eip155:8453': { ...scoped.namespaces.eip155, accounts: [`eip155:8453:${alice}`] } }
    expect(walletConnectSessionRecord(scoped, 8453, alice).chains).toEqual([8453])
    scoped.namespaces['eip155:8453'].accounts = [`eip155:8453:${bob}`]
    expect(() => walletConnectSessionRecord(scoped, 8453, alice)).toThrow('does not authorize')
  })
})
