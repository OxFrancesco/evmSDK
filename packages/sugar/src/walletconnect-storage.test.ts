import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareWalletConnectStorage, protectWalletConnectWrites } from './walletconnect-storage'

const mode = (path: string) => statSync(path).mode & 0o777

test('new WalletConnect storage and permissive existing descendants are private before use', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'bee-wc-storage-'))
  try {
    const root = join(temp, 'wallet')
    const dir = prepareWalletConnectStorage(root)
    expect(mode(root)).toBe(0o700)
    expect(mode(dir)).toBe(0o700)
    mkdirSync(join(dir, 'legacy'), { mode: 0o755 })
    writeFileSync(join(dir, 'legacy', 'key'), 'test-only', { mode: 0o644 })
    chmodSync(root, 0o755)
    prepareWalletConnectStorage(root)
    expect(mode(join(dir, 'legacy'))).toBe(0o700)
    expect(mode(join(dir, 'legacy', 'key'))).toBe(0o600)
    const storage = { async setItem<T>(_key: string, value: T) {
      expect(mode(dir)).toBe(0o700)
      writeFileSync(join(dir, 'new-key'), JSON.stringify(value), { mode: 0o644 })
    } }
    protectWalletConnectWrites(storage, dir)
    await storage.setItem('key', { test: true })
    expect(mode(join(dir, 'new-key'))).toBe(0o600)
    expect(readFileSync(join(dir, 'legacy', 'key'), 'utf8')).toBe('test-only')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('storage rejects symlinks without changing their target', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bee-wc-symlink-'))
  try {
    const root = join(temp, 'wallet')
    const dir = prepareWalletConnectStorage(root)
    const outside = join(temp, 'outside')
    writeFileSync(outside, 'test-only', { mode: 0o644 })
    symlinkSync(outside, join(dir, 'link'))
    expect(() => prepareWalletConnectStorage(root)).toThrow(/symbolic links/)
    expect(mode(outside)).toBe(0o644)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
