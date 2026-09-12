import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import type { Address } from 'viem'
import {
  confirmPrompt,
  deleteLocalWallet,
  getActiveWallet,
  loadLocalWallet,
  promptLine,
  parseMnemonic,
  saveLocalWallet,
  sealSecret,
  walletDir,
} from '../wallet'
import { fromPromise } from './run-action'

const passphraseFromEnvOrPrompt = Effect.fn('AeroCli.passphraseFromEnvOrPrompt')(function* (label: string) {
  const env = process.env.SUGAR_WALLET_PASSPHRASE
  if (env) return env
  return yield* fromPromise(() => promptLine(label, true))
})

const createOrRestoreWallet = Effect.fn('AeroCli.createOrRestoreWallet')(function* (restore: boolean) {
  if (loadLocalWallet() && !(yield* fromPromise(() => confirmPrompt('A local wallet already exists. Overwrite it?')))) {
    yield* Console.log('Keeping the existing wallet.')
    return
  }
  const { english, generateMnemonic, mnemonicToAccount } = yield* Effect.promise(() => import('viem/accounts'))
  const mnemonic = restore
    ? (yield* fromPromise(() => promptLine('Mnemonic (input hidden): ', true))).trim().toLowerCase().replace(/\s+/g, ' ')
    : generateMnemonic(english)
  let address: Address
  try {
    address = mnemonicToAccount(parseMnemonic(mnemonic)).address
  } catch {
    throw new Error('that is not a valid BIP-39 mnemonic')
  }
  if (!restore) {
    yield* Console.log('\nYour new wallet mnemonic (write it down, it is shown ONCE and never stored in plaintext):\n')
    yield* Console.log(`  ${mnemonic}\n`)
  }
  const passphrase = yield* passphraseFromEnvOrPrompt('Choose an encryption passphrase (min 8 chars): ')
  if (passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
  if (!process.env.SUGAR_WALLET_PASSPHRASE) {
    const repeat = yield* fromPromise(() => promptLine('Repeat passphrase: ', true))
    if (repeat !== passphrase) throw new Error('passphrases do not match')
  }
  if (!(yield* fromPromise(() => confirmPrompt(`Use ${address}? Default Ethereum account, no BIP-39 passphrase.`)))) return
  saveLocalWallet({ version: 1, kind: 'mnemonic', address, sealed: sealSecret(parseMnemonic(mnemonic), passphrase) })
  const backend = process.platform === 'darwin' && process.env.SUGAR_WALLET_NO_KEYCHAIN !== '1'
    ? 'macOS Keychain' : `encrypted file in ${walletDir()}`
  yield* Console.log(`Wallet ${restore ? 'restored' : 'created'}: ${address} (sealed with scrypt + AES-256-GCM, stored in the ${backend})`)
})

const connect = Command.make('connect', {}, Effect.fn(function* () {
  const { connectWalletConnect } = yield* Effect.promise(() => import('../walletconnect'))
  const record = yield* fromPromise(() => connectWalletConnect(console.log))
  yield* Console.log(`Connected ${record.peer ?? 'wallet'}: ${record.address} (chains: ${record.chains.join(', ')})`)
})).pipe(Command.withDescription('Pair a browser-extension or mobile wallet over WalletConnect'))

const create = Command.make('create', {}, Effect.fn(function* () {
  yield* createOrRestoreWallet(false)
})).pipe(Command.withDescription('Generate a wallet; the mnemonic is encrypted (scrypt + AES-256-GCM) and stored in the macOS Keychain (file fallback elsewhere)'))

const restore = Command.make('restore', {}, Effect.fn(function* () {
  yield* createOrRestoreWallet(true)
})).pipe(Command.withDescription('Import an existing mnemonic into the encrypted store'))

const status = Command.make('status', {}, Effect.fn(function* () {
  const active = getActiveWallet()
  if (!active) {
    yield* Console.log('No wallet configured. Run: aero wallet connect (WalletConnect) or aero wallet create / restore (local).')
    return
  }
  if (active.source === 'walletconnect') {
    yield* Console.log(`Active wallet: ${active.address} via WalletConnect (${active.peer ?? 'unknown wallet'}, chains: ${active.chains.join(', ')})`)
    const local = loadLocalWallet()
    if (local) {
      yield* Console.log(`Also stored: local wallet ${local.address} (used when WalletConnect is disconnected)`)
    }
    return
  }
  yield* Console.log(`Active wallet: ${active.address} (local encrypted wallet)`)
})).pipe(Command.withDescription('Show the active wallet'))

const disconnect = Command.make('disconnect', {}, Effect.fn(function* () {
  const { disconnectWalletConnect } = yield* Effect.promise(() => import('../walletconnect'))
  const removed = yield* fromPromise(() => disconnectWalletConnect())
  yield* Console.log(removed ? 'WalletConnect session disconnected.' : 'No WalletConnect session to disconnect.')
})).pipe(Command.withDescription('Drop the WalletConnect session'))

const remove = Command.make('remove', {}, Effect.fn(function* () {
  const wallet = loadLocalWallet()
  if (!wallet) {
    yield* Console.log('No local wallet stored.')
    return
  }
  const confirmed = yield* fromPromise(() =>
    confirmPrompt(`Delete the encrypted wallet for ${wallet.address}? Without the mnemonic backup the funds are unrecoverable.`),
  )
  if (!confirmed) {
    yield* Console.log('Keeping the wallet.')
    return
  }
  deleteLocalWallet()
  yield* Console.log('Local wallet deleted.')
})).pipe(Command.withDescription('Delete the local encrypted wallet'))

export const walletCommand = Command.make('wallet').pipe(
  Command.withDescription('Connect, create, inspect, or remove the signing wallet'),
  Command.withSubcommands([connect, create, restore, status, disconnect, remove]),
)
