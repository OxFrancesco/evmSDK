import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function secureTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('WalletConnect storage cannot contain symbolic links')
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('WalletConnect storage contains an unsupported file')
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) for (const name of readdirSync(path)) secureTree(join(path, name))
}

export function prepareWalletConnectStorage(walletRoot: string): string {
  if (!existsSync(walletRoot)) mkdirSync(walletRoot, { recursive: true, mode: 0o700 })
  if (!lstatSync(walletRoot).isDirectory() || lstatSync(walletRoot).isSymbolicLink()) throw new Error('Wallet directory must be a real directory')
  chmodSync(walletRoot, 0o700)
  const directory = join(walletRoot, 'walletconnect')
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
  secureTree(directory)
  return directory
}

type WritableStorage = { setItem<T>(key: string, value: T): Promise<void> }

/** Private ancestry protects new files while the SDK finishes its write. */
export function protectWalletConnectWrites(storage: WritableStorage, directory: string): void {
  secureTree(directory)
  const write = storage.setItem.bind(storage)
  storage.setItem = async (key, value) => {
    secureTree(directory)
    try { await write(key, value) }
    finally { secureTree(directory) }
  }
}
