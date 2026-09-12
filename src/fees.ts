import { Effect } from 'effect'
import { parseAbi, serializeTransaction } from 'viem'
import type { PrepareInput } from './model'
import { Network, rpc } from './network'

const oracle = '0x420000000000000000000000000000000000000F'
const oracleAbi = parseAbi(['function getL1FeeUpperBound(uint256 txSize) view returns (uint256)'])
export const estimateFees = Effect.fn('Fees.estimate')(function* (input: PrepareInput, gas: bigint) {
  const client = yield* (yield* Network).client(input.chainId)
  const block = yield* rpc(() => client.getBlock())
  if (block.baseFeePerGas === null) {
    const gasPrice = yield* rpc(() => client.getGasPrice())
    return { feeType: 'legacy' as const, gasPrice: gasPrice.toString(), l1FeeEstimate: '0' }
  }
  const fees = yield* rpc(() => client.estimateFeesPerGas())
  let l1FeeEstimate = '0'
  if ([8453, 84532, 10, 11155420].includes(input.chainId)) {
    const raw = serializeTransaction({ type: 'eip1559', chainId: input.chainId, to: input.to, data: input.data, value: BigInt(input.value), gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce: 0 })
    l1FeeEstimate = (yield* rpc(() => client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((raw.length - 2) / 2 + 80)] }))).toString()
  }
  return { feeType: 'eip1559' as const, gasPrice: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), l1FeeEstimate }
})
