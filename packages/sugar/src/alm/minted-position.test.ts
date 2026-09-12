import { expect, test } from 'bun:test'
import { keccak256, toBytes, padHex, toHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ADDRESS_ZERO } from '../types'
import { mintedPositionId } from './minted-position'
const owner: Address = '0x1111111111111111111111111111111111111111'
const manager: Address = '0x2222222222222222222222222222222222222222'
const donor: Address = '0x3333333333333333333333333333333333333333'
const hash = `0x${'1'.repeat(64)}` as const
const log = (id: bigint, from = ADDRESS_ZERO, address = manager) => ({ address, data: '0x' as const, topics: [keccak256(toBytes('Transfer(address,address,uint256)')), padHex(from, { size: 32 }), padHex(owner, { size: 32 }), toHex(id, { size: 32 })] satisfies [Hex, ...Hex[]], blockHash: hash, blockNumber: 1n, transactionHash: hash, transactionIndex: 0, logIndex: 0, removed: false })
const receipt: TransactionReceipt = { from: owner, to: manager, status: 'success', transactionHash: hash, transactionIndex: 0, blockHash: hash, blockNumber: 1n, cumulativeGasUsed: 1n, gasUsed: 1n, contractAddress: null, logs: [], logsBloom: '0x', effectiveGasPrice: 1n, type: 'eip1559' }
test('receipt provenance ignores donated NFTs and other contracts, rejects missing or ambiguous mints', () => {
  expect(mintedPositionId([{ ...receipt, logs: [log(43n), log(999n, donor), log(888n, ADDRESS_ZERO, donor)] }], manager, owner)).toBe(43n)
  expect(() => mintedPositionId([{ ...receipt, logs: [log(999n, donor)] }], manager, owner)).toThrow('exactly one')
  expect(() => mintedPositionId([{ ...receipt, logs: [log(43n), log(44n)] }], manager, owner)).toThrow('exactly one')
  expect(() => mintedPositionId([{ ...receipt, status: 'reverted', logs: [log(43n)] }], manager, owner)).toThrow('receipt')
})
