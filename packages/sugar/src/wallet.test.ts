import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatCliError, splitSendFlags } from './cli'
import { extractPlanSteps, localMnemonicSigner, renderPlanSummary } from './send'
import type { SugarJson } from './types'
import {
  deleteLocalWallet, deleteWalletConnectRecord, getActiveWallet, loadLocalWallet,
  loadWalletConnectRecord, openSecret, saveLocalWallet, saveWalletConnectRecord, sealSecret,
} from './wallet'

const ADDRESS = '0x1111111111111111111111111111111111111111' as const
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sugar-wallet-'))
  process.env.SUGAR_WALLET_DIR = dir
  process.env.SUGAR_WALLET_NO_KEYCHAIN = '1'
})

afterEach(() => {
  delete process.env.SUGAR_WALLET_DIR
  delete process.env.SUGAR_WALLET_NO_KEYCHAIN
  rmSync(dir, { recursive: true, force: true })
})

describe('sealed secrets', () => {
  test('round-trips a mnemonic with the right passphrase', () => {
    const sealed = sealSecret(TEST_MNEMONIC, 'correct horse battery staple')
    expect(openSecret(sealed, 'correct horse battery staple')).toBe(TEST_MNEMONIC)
  })

  test('rejects the wrong passphrase without leaking plaintext', () => {
    const sealed = sealSecret(TEST_MNEMONIC, 'correct horse battery staple')
    expect(() => openSecret(sealed, 'wrong passphrase')).toThrow('wrong passphrase')
  })

  test('never stores the secret in the clear', () => {
    const sealed = sealSecret(TEST_MNEMONIC, 'correct horse battery staple')
    expect(JSON.stringify(sealed)).not.toContain('junk')
  })

  test('requires a passphrase', () => {
    expect(() => sealSecret(TEST_MNEMONIC, '')).toThrow('passphrase')
  })
})

describe('wallet store', () => {
  const record = { version: 1 as const, kind: 'mnemonic' as const, address: ADDRESS, sealed: sealSecret(TEST_MNEMONIC, 'passphrase123') }

  test('saves, loads, and deletes the local wallet via the file fallback', () => {
    expect(loadLocalWallet()).toBeUndefined()
    saveLocalWallet(record)
    expect(loadLocalWallet()?.address).toBe(ADDRESS)
    expect(deleteLocalWallet()).toBe(true)
    expect(loadLocalWallet()).toBeUndefined()
  })

  test('walletconnect record round-trips and wins the active-wallet pick', () => {
    saveLocalWallet(record)
    expect(getActiveWallet()).toEqual({ source: 'local', address: ADDRESS })
    saveWalletConnectRecord({ version: 1, topic: 'topic-1', address: '0x2222222222222222222222222222222222222222', chains: [8453], peer: 'Rabby' })
    expect(getActiveWallet()).toMatchObject({ source: 'walletconnect', topic: 'topic-1', peer: 'Rabby' })
    expect(loadWalletConnectRecord()?.chains).toEqual([8453])
    expect(deleteWalletConnectRecord()).toBe(true)
    expect(getActiveWallet()).toEqual({ source: 'local', address: ADDRESS })
  })
})

describe('send plan plumbing', () => {
  const plan: SugarJson = {
    transactions: [],
    transaction_steps: [
      { role: 'approval', transaction: { from: ADDRESS, to: '0x3333333333333333333333333333333333333333', data: '0xabcdef', value: '0' } },
      { role: 'action', transaction: { from: ADDRESS, to: '0x4444444444444444444444444444444444444444', data: '0x123456', value: '1000000000000000000' } },
    ],
    quote: {
      from_token: { symbol: 'ETH' }, to_token: { symbol: 'USDC' },
      amount_in_decimal: 0.5, amount_out_decimal: 1234.5, min_amount_out_decimal: 1222.2,
      slippage: 0.01, price_impact_pct: 0.123456,
    },
  }

  test('extractPlanSteps rehydrates bigint values', () => {
    const steps = extractPlanSteps(plan)
    expect(steps).toHaveLength(2)
    expect(steps[0].role).toBe('approval')
    expect(steps[1].transaction.value).toBe(1000000000000000000n)
  })

  test('extractPlanSteps rejects read outputs', () => {
    expect(() => extractPlanSteps([])).toThrow()
    expect(() => extractPlanSteps({ pools: [] })).toThrow('transaction plan')
  })

  test('renderPlanSummary shows swap amounts and slippage floor', () => {
    const steps = extractPlanSteps(plan)
    const summary = renderPlanSummary('swap', plan, steps)
    expect(summary).toContain('2 transactions, approvals first')
    expect(summary).toContain('0.5 ETH -> 1234.5 USDC')
    expect(summary).toContain('min out: 1222.2 USDC')
    expect(summary).toContain('0.123%')
  })

  test('invalid mnemonic words and checksums are rejected before signing', () => {
    expect(() => localMnemonicSigner('notaword '.repeat(12).trim())).toThrow('BIP-39')
    expect(() => localMnemonicSigner('abandon '.repeat(12).trim())).toThrow('BIP-39')
  })

  test('localMnemonicSigner derives the standard dev address', () => {
    const signer = localMnemonicSigner(TEST_MNEMONIC)
    expect(signer.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(signer.describe).toBe('local wallet')
  })
})

describe('CLI send flags', () => {
  test('splitSendFlags strips --yes and --dry-run and keeps action flags', () => {
    expect(splitSendFlags(['swap', '--yes', '--chain=8453', '--dry-run', '--amount', '1'])).toEqual({
      argv: ['swap', '--chain=8453', '--amount', '1'],
      yes: true,
      dryRun: true,
    })
  })

  test('splitSendFlags defaults to interactive broadcast', () => {
    expect(splitSendFlags(['quote'])).toEqual({ argv: ['quote'], yes: false, dryRun: false })
  })

  test('formatCliError renders WalletConnect object rejections readably', () => {
    expect(formatCliError(new Error('boom'))).toBe('boom')
    expect(formatCliError({ message: 'Proposal expired', code: 0 })).toBe('Proposal expired (code 0)')
    expect(formatCliError({ message: 'User rejected' })).toBe('User rejected')
    expect(formatCliError({ weird: true })).toBe('{"weird":true}')
    expect(formatCliError('plain')).toBe('plain')
  })
})
