import { parseEventLogs, type Address, type TransactionReceipt } from 'viem'
import { ADDRESS_ZERO } from '../types'

export const nftTransferEvent = [{
  type: 'event', name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
}] as const

export function mintedPositionId(receipts: readonly TransactionReceipt[], manager: Address, owner: Address): bigint {
  const ids = receipts.flatMap((receipt) => {
    if (receipt.status !== 'success' || receipt.from.toLowerCase() !== owner.toLowerCase()) throw new Error('Deposit receipt does not belong to the managed wallet')
    return parseEventLogs({ abi: nftTransferEvent, logs: receipt.logs, strict: true })
      .filter((log) => log.address.toLowerCase() === manager.toLowerCase()
        && log.args.from === ADDRESS_ZERO && log.args.to.toLowerCase() === owner.toLowerCase())
      .map((log) => log.args.tokenId)
  })
  if (ids.length !== 1 || ids[0] <= 0n) throw new Error('Deposit receipts must identify exactly one minted position')
  return ids[0]
}
