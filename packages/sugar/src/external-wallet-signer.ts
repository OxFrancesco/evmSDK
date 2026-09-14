import type { PlanSigner } from './send'
import { getActiveWallet } from './wallet'

export function externalWalletSigner(log: (line: string) => void): PlanSigner | undefined {
  const wallet = getActiveWallet()
  if (!wallet || wallet.source === 'local') return undefined
  if (wallet.source === 'browser') {
    return {
      address: wallet.address, describe: `${wallet.peer} in browser`,
      send: async (transaction, chainId) => {
        const { browserWalletSendTransaction } = await import('./browser-wallet')
        return browserWalletSendTransaction(transaction, chainId, log)
      },
    }
  }
  return {
    address: wallet.address, describe: `WalletConnect (${wallet.peer ?? 'wallet'})`,
    send: async (transaction, chainId) => {
      const { walletConnectSendTransaction } = await import('./walletconnect')
      return walletConnectSendTransaction(transaction, chainId, log)
    },
  }
}
