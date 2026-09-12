import type { Address } from 'viem'
import { isSupportedChainId } from './config'
import { normalizeAddress } from './helpers'
import type { WalletConnectRecord } from './wallet'

type SignClientInstance = Awaited<ReturnType<(typeof import('@walletconnect/sign-client'))['SignClient']['init']>>
type Session = ReturnType<SignClientInstance['session']['getAll']>[number]
export type WalletConnectSession = Pick<Session, 'topic' | 'expiry' | 'namespaces' | 'peer'>

export function walletConnectSessionRecord(
  session: WalletConnectSession,
  chainId?: number,
  selectedAddress?: Address,
): WalletConnectRecord {
  if (session.expiry <= Date.now() / 1_000) throw new Error('WalletConnect session expired; reconnect the wallet')
  const accounts: { chainId: number; address: Address }[] = []
  for (const [namespace, permissions] of Object.entries(session.namespaces)) {
    if (namespace !== 'eip155' && !namespace.startsWith('eip155:')) continue
    if (!permissions.methods.includes('eth_sendTransaction')) continue
    for (const value of permissions.accounts) {
      const match = /^eip155:([1-9]\d*):(0x[0-9a-f]{40})$/i.exec(value)
      if (!match) throw new Error('WalletConnect returned an invalid account')
      const accountChain = Number(match[1])
      if (!Number.isSafeInteger(accountChain) || !isSupportedChainId(accountChain)) continue
      if (namespace !== 'eip155' && namespace !== `eip155:${accountChain}`) continue
      if (permissions.chains && !permissions.chains.includes(`eip155:${accountChain}`)) continue
      accounts.push({ chainId: accountChain, address: normalizeAddress(match[2]) })
    }
  }
  const selected = accounts.find((account) =>
    (chainId === undefined || account.chainId === chainId)
    && (selectedAddress === undefined || account.address === normalizeAddress(selectedAddress)),
  )
  if (!selected) throw new Error('WalletConnect does not authorize this account and chain to send transactions; reconnect the wallet')
  return {
    version: 2, topic: session.topic, address: selected.address,
    chains: [...new Set(accounts.filter((account) => account.address === selected.address).map((account) => account.chainId))],
    accounts, peer: session.peer.metadata.name,
  }
}
