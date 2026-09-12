import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { formatCliError } from '../../cli'
import { deleteLocalWallet, loadLocalWallet, loadWalletConnectRecord, parseMnemonic, saveLocalWallet, sealSecret, walletDir } from '../../wallet'
import { ConfirmDialog, Dialog, PromptDialog } from '../dialogs'
import { theme } from '../theme'
import { useApp } from '../store'
import { ScreenFrame, shortAddress, Spinner } from '../widgets'

function MnemonicDialog(props: { mnemonic: string; close: () => void; onConfirm: () => void }) {
  const words = props.mnemonic.split(' ')
  useKeyboard((key) => {
    if (key.name === 'escape') return props.close()
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
      props.close()
      props.onConfirm()
    }
  })
  return (
    <Dialog title="Write down your mnemonic" width={58} hints={[{ key: 'enter', label: 'I wrote it down' }, { key: 'esc', label: 'abort' }]}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={theme.warning}>Shown ONCE and never stored in plaintext.</text>
      </box>
      <box paddingLeft={1} paddingTop={1} paddingBottom={1} flexDirection="row" flexWrap="wrap">
        {words.map((word, index) => (
          <box key={`${index}-${word}`} width={18} height={1}>
            <text fg={theme.text}>
              <span fg={theme.textMuted}>{String(index + 1).padStart(2)} </span>
              {word}
            </text>
          </box>
        ))}
      </box>
    </Dialog>
  )
}

type Mode = { kind: 'menu' } | { kind: 'connect'; lines: string[] }

export function WalletScreen() {
  const app = useApp()
  const [mode, setMode] = useState<Mode>({ kind: 'menu' })
  const [selected, setSelected] = useState(0)
  const connecting = useRef(false)
  const refreshWallet = app.refreshWallet
  useEffect(() => {
    refreshWallet()
  }, [refreshWallet])

  const local = loadLocalWallet()
  const wc = loadWalletConnectRecord()

  const finishSave = (address: Address, mnemonic: string, restored: boolean) => {
    const save = (passphrase: string) => {
      saveLocalWallet({ version: 1, kind: 'mnemonic', address, sealed: sealSecret(mnemonic, passphrase) })
      app.refreshWallet()
      const backend = process.platform === 'darwin' && process.env.SUGAR_WALLET_NO_KEYCHAIN !== '1'
        ? 'macOS Keychain'
        : `encrypted file in ${walletDir()}`
      app.toast('success', `Wallet ${restored ? 'restored' : 'created'}`, `${shortAddress(address)} sealed in the ${backend}`)
    }
    const env = process.env.SUGAR_WALLET_PASSPHRASE
    if (env) return save(env)
    app.openDialog((close) => (
      <PromptDialog
        title="Encryption passphrase"
        label="Choose a passphrase (min 8 chars)"
        mask
        close={close}
        onSubmit={(passphrase) => {
          if (passphrase.length < 8) return app.toast('error', 'Too short', 'The passphrase needs at least 8 characters')
          app.openDialog((closeRepeat) => (
            <PromptDialog
              title="Repeat passphrase"
              mask
              close={closeRepeat}
              onSubmit={(repeat) => {
                if (repeat !== passphrase) return app.toast('error', 'Mismatch', 'The passphrases do not match')
                save(passphrase)
              }}
            />
          ))
        }}
      />
    ))
  }

  const createWallet = async (restore: boolean) => {
    const { english, generateMnemonic, mnemonicToAccount } = await import('viem/accounts')
    const begin = () => {
      if (restore) {
        app.openDialog((close) => (
          <PromptDialog
            title="Restore wallet"
            label="Mnemonic (input hidden)"
            mask
            close={close}
            onSubmit={(raw) => {
              try {
                const mnemonic = parseMnemonic(raw)
                const address = mnemonicToAccount(mnemonic).address
                app.openDialog((closeConfirm) => (
                  <ConfirmDialog title="Confirm restored address" message={`${address}. Default Ethereum account, no BIP-39 passphrase. Is this the wallet you expect?`} close={closeConfirm} onConfirm={() => finishSave(address, mnemonic, true)} />
                ))
              } catch {
                app.toast('error', 'Invalid mnemonic', 'That is not a valid BIP-39 mnemonic')
              }
            }}
          />
        ))
        return
      }
      const mnemonic = generateMnemonic(english)
      const address = mnemonicToAccount(mnemonic).address
      app.openDialog((close) => (
        <MnemonicDialog mnemonic={mnemonic} close={close} onConfirm={() => finishSave(address, mnemonic, false)} />
      ))
    }
    if (loadLocalWallet()) {
      app.openDialog((close) => (
        <ConfirmDialog
          title="Overwrite wallet?"
          message="A local wallet already exists. Overwrite it?"
          confirmLabel="Overwrite"
          danger
          close={close}
          onConfirm={begin}
        />
      ))
      return
    }
    begin()
  }

  const connect = async () => {
    if (connecting.current) return
    connecting.current = true
    setMode({ kind: 'connect', lines: [] })
    const append = (line: string) => setMode((current) => (
      current.kind === 'connect' ? { kind: 'connect', lines: [...current.lines, ...line.split('\n')] } : current
    ))
    try {
      const { connectWalletConnect } = await import('../../walletconnect')
      const record = await connectWalletConnect(append, app.chain)
      app.refreshWallet()
      app.toast('success', 'Wallet connected', `${record.peer ?? 'wallet'}: ${shortAddress(record.address)}`)
    } catch (cause) {
      app.toast('error', 'Connect failed', formatCliError(cause))
    } finally {
      connecting.current = false
      setMode({ kind: 'menu' })
    }
  }

  const disconnect = () => {
    app.openDialog((close) => (
      <ConfirmDialog
        title="Disconnect WalletConnect?"
        message="Drop the WalletConnect session. A stored local wallet stays untouched."
        confirmLabel="Disconnect"
        close={close}
        onConfirm={() => {
          void (async () => {
            const { disconnectWalletConnect } = await import('../../walletconnect')
            await disconnectWalletConnect()
            app.refreshWallet()
            app.toast('info', 'Disconnected', 'WalletConnect session dropped')
          })()
        }}
      />
    ))
  }

  const remove = () => {
    const wallet = loadLocalWallet()
    if (!wallet) return
    app.openDialog((close) => (
      <ConfirmDialog
        title="Delete local wallet?"
        message={`Delete the encrypted wallet for ${shortAddress(wallet.address)}? Without the mnemonic backup the funds are unrecoverable.`}
        confirmLabel="Delete"
        danger
        close={close}
        onConfirm={() => {
          deleteLocalWallet()
          app.refreshWallet()
          app.toast('info', 'Wallet deleted', 'The local encrypted wallet is gone')
        }}
      />
    ))
  }

  const items = [
    { title: 'Connect WalletConnect', description: 'pair a browser or mobile wallet by QR', run: () => void connect() },
    { title: 'Create local wallet', description: 'new mnemonic, sealed with scrypt + AES-256-GCM', run: () => void createWallet(false) },
    { title: 'Restore local wallet', description: 'import an existing mnemonic', run: () => void createWallet(true) },
    ...(wc ? [{ title: 'Disconnect WalletConnect', description: wc.peer ?? wc.address, run: disconnect }] : []),
    ...(local ? [{ title: 'Remove local wallet', description: shortAddress(local.address), run: remove }] : []),
  ]

  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') {
      if (mode.kind === 'connect') return
      return app.pop()
    }
    if (mode.kind !== 'menu') return
    if (key.name === 'up' || key.name === 'k') return setSelected((at) => (at + items.length - 1) % items.length)
    if (key.name === 'down' || key.name === 'j') return setSelected((at) => (at + 1) % items.length)
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') return items[Math.min(selected, items.length - 1)]?.run()
  })

  if (mode.kind === 'connect') {
    return (
      <ScreenFrame title="Connect a wallet" hints={[{ key: 'ctrl+c', label: 'quit' }]}>
        <box flexGrow={1} minHeight={0} gap={1}>
          <Spinner label="Waiting for wallet approval..." />
          <scrollbox flexGrow={1} minHeight={0}>
            {mode.lines.map((line, index) => (
              <text key={index} fg={theme.text} selectable>{line === '' ? ' ' : line}</text>
            ))}
          </scrollbox>
        </box>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame title="Wallet" hints={[{ key: '↑↓', label: 'move' }, { key: 'enter', label: 'select' }, { key: 'esc', label: 'back' }]}>
      <box flexGrow={1} minHeight={0} gap={1}>
        <box border borderStyle="rounded" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          {app.wallet ? (
            <>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                <span fg={theme.success}>● </span>
                {app.wallet.address}
              </text>
              <text fg={theme.textMuted}>
                {app.wallet.source === 'walletconnect'
                  ? `WalletConnect · ${app.wallet.peer ?? 'unknown wallet'} · chains ${app.wallet.chains.join(', ')}`
                  : 'Local encrypted wallet (signs after you enter the passphrase)'}
              </text>
              {app.wallet.source === 'walletconnect' && local ? (
                <text fg={theme.textMuted}>Also stored: local wallet {shortAddress(local.address)} (used when WalletConnect is disconnected)</text>
              ) : null}
            </>
          ) : (
            <text fg={theme.textMuted}>No wallet configured. Connect one to sign and broadcast plans.</text>
          )}
        </box>
        <box>
          {items.map((item, index) => {
            const active = index === Math.min(selected, items.length - 1)
            return (
              <box key={item.title} height={1} paddingLeft={1} paddingRight={1} backgroundColor={active ? theme.primary : undefined}>
                <text fg={active ? theme.selectedText : theme.text}>
                  {item.title}
                  <span fg={active ? theme.selectedText : theme.textMuted}>  {item.description}</span>
                </text>
              </box>
            )
          })}
        </box>
      </box>
    </ScreenFrame>
  )
}
