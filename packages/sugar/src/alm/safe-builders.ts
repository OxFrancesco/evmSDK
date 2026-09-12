import { encodeFunctionData, type Address } from 'viem'
import { abis } from '../abis'
import type { SugarClient } from '../client'
import { applySlippage, futureTimestamp, normalizeAddress, tokenContractAddress } from '../helpers'
import { MAX_UINT128, type DepositQuote, type Position, type UnsignedTransaction } from '../types'

/**
 * Safe-mode variants of the CL plan builders.
 *
 * The Roles Modifier scopes permissions per function selector, so plans must
 * avoid `NFPM.multicall` (a wildcard multicall would swallow the per-call
 * conditions) and must never carry native ether (the role forbids Send).
 * Withdrawals therefore run decreaseLiquidity / collect / burn as separate
 * calls, and deposits mint with plain ERC20 approvals — WETH stays WETH.
 */

function tx(from: Address, to: Address, data: `0x${string}`): UnsignedTransaction {
  return { from, to, data, value: 0n }
}

/** decreaseLiquidity -> collect(recipient = safe) -> burn, one call each. */
export function buildSafeWithdraw(
  safe: Address,
  position: Position,
  slippage: number,
  deadlineMinutes = 30,
): UnsignedTransaction[] {
  if (!position.pool.isCl) throw new Error('safe mode manages CL positions only')
  if (position.liquidity <= 0n) throw new Error('position has no liquidity to withdraw')
  const nfpm = position.pool.nfpm
  const deadline = futureTimestamp(deadlineMinutes)
  const decrease = encodeFunctionData({
    abi: abis.nfpm,
    functionName: 'decreaseLiquidity',
    args: [[position.id, position.liquidity, applySlippage(position.amountToken0, slippage), applySlippage(position.amountToken1, slippage), deadline]],
  })
  const collect = encodeFunctionData({
    abi: abis.nfpm,
    functionName: 'collect',
    args: [[position.id, safe, MAX_UINT128, MAX_UINT128]],
  })
  const burn = encodeFunctionData({ abi: abis.nfpm, functionName: 'burn', args: [position.id] })
  return [tx(safe, nfpm, decrease), tx(safe, nfpm, collect), tx(safe, nfpm, burn)]
}

/** ERC20-only mint: exact-amount approvals to the NFPM, then a plain mint. */
export async function buildSafeDeposit(
  client: SugarClient,
  safe: Address,
  quote: DepositQuote,
  slippage: number,
  deadlineMinutes = 30,
): Promise<UnsignedTransaction[]> {
  const { pool } = quote
  if (!pool.isCl) throw new Error('safe mode manages CL positions only')
  if (quote.tickLower === undefined || quote.tickUpper === undefined) throw new Error('CL deposit quote requires ticks')
  const transactions: UnsignedTransaction[] = []
  for (const [token, amount] of [[pool.token0, quote.amountToken0], [pool.token1, quote.amountToken1]] as const) {
    if (amount <= 0n) continue
    const allowance = await client.checkTokenAllowance(token, pool.nfpm)
    if (allowance < amount) {
      transactions.push(tx(safe, tokenContractAddress(token), encodeFunctionData({
        abi: abis.erc20,
        functionName: 'approve',
        args: [pool.nfpm, amount],
      })))
    }
  }
  const mintArgs = [
    normalizeAddress(pool.token0.tokenAddress),
    normalizeAddress(pool.token1.tokenAddress),
    pool.type,
    quote.tickLower,
    quote.tickUpper,
    quote.amountToken0,
    quote.amountToken1,
    applySlippage(quote.amountToken0, slippage),
    applySlippage(quote.amountToken1, slippage),
    safe,
    futureTimestamp(deadlineMinutes),
    quote.sqrtPriceX96,
  ] as const
  transactions.push(tx(safe, pool.nfpm, encodeFunctionData({ abi: abis.nfpm, functionName: 'mint', args: [mintArgs] })))
  return transactions
}
