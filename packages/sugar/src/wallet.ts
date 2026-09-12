import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAddress, type Address } from 'viem'
import * as Schema from 'effect/Schema'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

export function parseMnemonic(value: string): string {
  const mnemonic = value.normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid BIP-39 mnemonic: check the words and checksum')
  return mnemonic
}

/**
 * Wallet storage for the sugar-ts / aero CLI.
 *
 * Local wallets keep the mnemonic sealed with scrypt + AES-256-GCM. The
 * sealed payload lives in the macOS Keychain (generic password, syncable via
 * iCloud Keychain) and falls back to a 0600 file on other platforms. The
 * plaintext mnemonic never touches disk and never leaves this process.
 */

const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYCHAIN_SERVICE = 'beegreat-sugar-cli'
const KEYCHAIN_ACCOUNT = 'local-wallet'

export type SealedSecret = {
  v: 1
  kdf: 'scrypt'
  n: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

export function sealSecret(secret: string, passphrase: string): SealedSecret {
  if (!passphrase) throw new Error('a passphrase is required to encrypt the wallet')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    v: 1, kdf: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  }
}

export function openSecret(sealed: SealedSecret, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, 'base64'), 32, { N: sealed.n, r: sealed.r, p: sealed.p, maxmem: 128 * 1024 * 1024 })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('wrong passphrase (or the stored wallet is corrupted)')
  }
}

export type LocalWalletRecord = {
  version: 1
  kind: 'mnemonic'
  address: Address
  sealed: SealedSecret
}

type WalletConnectIdentity = {
  topic: string
  address: Address
  chains: number[]
  peer?: string
}

export type WalletConnectRecord = WalletConnectIdentity & (
  | { version: 1 }
  | { version: 2; accounts: { chainId: number; address: Address }[] }
)

const walletConnectIdentitySchema = Schema.Struct({
  topic: Schema.NonEmptyString,
  address: Schema.String,
  chains: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
  peer: Schema.optionalKey(Schema.String),
})
const walletConnectRecordSchema = Schema.Union([
  Schema.Struct({ ...walletConnectIdentitySchema.fields, version: Schema.Literal(1) }),
  Schema.Struct({ ...walletConnectIdentitySchema.fields, version: Schema.Literal(2), accounts: Schema.Array(Schema.Struct({
    chainId: Schema.Int.check(Schema.isGreaterThan(0)), address: Schema.String,
  })) }),
])

export type ActiveWallet =
  | { source: 'local'; address: Address }
  | { source: 'walletconnect'; address: Address; topic: string; chains: number[]; peer?: string }

export function walletDir(): string {
  return process.env.SUGAR_WALLET_DIR ?? join(homedir(), '.config', 'sugar-ts')
}

function ensureDir(): string {
  const dir = walletDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function security(args: string[]): string {
  return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function keychainAvailable(): boolean {
  if (process.env.SUGAR_WALLET_NO_KEYCHAIN === '1') return false
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('which', ['security'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function fallbackPath(): string {
  return join(walletDir(), 'wallet.enc')
}

export function saveLocalWallet(record: LocalWalletRecord): void {
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64')
  if (keychainAvailable()) {
    security(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', payload])
    return
  }
  ensureDir()
  writeFileSync(fallbackPath(), payload, { mode: 0o600 })
  chmodSync(fallbackPath(), 0o600)
}

export function loadLocalWallet(): LocalWalletRecord | undefined {
  let payload: string | undefined
  if (keychainAvailable()) {
    try {
      payload = security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']).trim()
    } catch {
      payload = undefined
    }
  }
  if (!payload && existsSync(fallbackPath())) payload = readFileSync(fallbackPath(), 'utf8').trim()
  if (!payload) return undefined
  try {
    // SAFETY: the payload is only ever written by saveLocalWallet, which
    // serializes a LocalWalletRecord; unreadable payloads throw below.
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as LocalWalletRecord
  } catch {
    throw new Error('stored wallet payload is not readable; re-run wallet restore')
  }
}

export function deleteLocalWallet(): boolean {
  let removed = false
  if (keychainAvailable()) {
    try {
      security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT])
      removed = true
    } catch { /* nothing stored in the keychain */ }
  }
  if (existsSync(fallbackPath())) {
    rmSync(fallbackPath())
    removed = true
  }
  return removed
}

function wcPath(): string {
  return join(walletDir(), 'walletconnect-session.json')
}

export function saveWalletConnectRecord(record: WalletConnectRecord): void {
  ensureDir()
  writeFileSync(wcPath(), JSON.stringify(record, null, 2), { mode: 0o600 })
}

export function loadWalletConnectRecord(): WalletConnectRecord | undefined {
  if (!existsSync(wcPath())) return undefined
  try {
    const record = Schema.decodeUnknownSync(walletConnectRecordSchema)(JSON.parse(readFileSync(wcPath(), 'utf8')))
    const identity = { ...record, address: getAddress(record.address), chains: [...record.chains] }
    if (record.version === 1) return { ...identity, version: 1 }
    return { ...identity, version: 2, accounts: record.accounts.map((account) => ({ ...account, address: getAddress(account.address) })) }
  } catch {
    return undefined
  }
}

export function deleteWalletConnectRecord(): boolean {
  if (!existsSync(wcPath())) return false
  rmSync(wcPath())
  return true
}

/** WalletConnect wins over the local wallet when both exist: pairing is an explicit recent action. */
export function getActiveWallet(): ActiveWallet | undefined {
  const wc = loadWalletConnectRecord()
  if (wc) return { source: 'walletconnect', address: wc.address, topic: wc.topic, chains: wc.chains, peer: wc.peer }
  const local = loadLocalWallet()
  if (local) return { source: 'local', address: local.address }
  return undefined
}

export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Read one line from the terminal; `hidden` suppresses echo (passphrases, mnemonics). */
export async function promptLine(label: string, hidden = false): Promise<string> {
  const stdin = process.stdin
  const stdout = process.stdout
  if (!stdin.isTTY) throw new Error('this command needs an interactive terminal')
  stdout.write(label)
  stdin.setRawMode(true)
  stdin.resume()
  try {
    let value = ''
    const decoder = new TextDecoder()
    // SAFETY: a resumed raw-mode TTY ReadStream async-iterates Buffer chunks.
    for await (const chunk of stdin as AsyncIterable<Buffer>) {
      for (const char of decoder.decode(chunk, { stream: true })) {
        const byte = char.codePointAt(0)
        if (byte === 0x03) throw new Error('cancelled')
        if (byte === 0x0d || byte === 0x0a) {
          stdout.write('\n')
          return value
        }
        if (byte === 0x7f || byte === 0x08) {
          if (value.length > 0) {
            value = Array.from(value).slice(0, -1).join('')
            if (!hidden) stdout.write('\b \b')
          }
          continue
        }
        if (byte === undefined || byte < 0x20) continue
        value += char
        stdout.write(hidden ? '' : char)
      }
    }
    return value
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}

export async function confirmPrompt(question: string): Promise<boolean> {
  const answer = (await promptLine(`${question} [y/N] `)).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}
