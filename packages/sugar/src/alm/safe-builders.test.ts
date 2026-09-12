import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Address } from 'viem'
import { abis } from '../abis'
import { stubSugarClient } from '../test-support'
import type { DepositQuote, LiquidityPool, Position } from '../types'
import { buildSafeDeposit, buildSafeWithdraw } from './safe-builders'

const SAFE: Address = '0x1000000000000000000000000000000000000001'
const NFPM: Address = '0x2000000000000000000000000000000000000002'
const WETH = '0x7000000000000000000000000000000000000007'
const USDC = '0x8000000000000000000000000000000000000008'

/** The pool fields the safe builders actually read. */
interface LiquidityPoolStub {
  readonly lp: string
  readonly isCl: boolean
  readonly type: number
  readonly nfpm: Address
  readonly symbol: string
  readonly sqrtRatio: bigint
  readonly token0: { tokenAddress: string; symbol: string; decimals: number }
  readonly token1: { tokenAddress: string; symbol: string; decimals: number }
}

/** The position fields buildSafeWithdraw actually reads. */
interface PositionStub {
  readonly id: bigint
  readonly pool: LiquidityPool
  readonly liquidity: bigint
  readonly amountToken0: bigint
  readonly amountToken1: bigint
}

function stubPool(stub: LiquidityPoolStub): LiquidityPool {
  const widened: object = stub
  // SAFETY: the safe builders only read the CL fields provided by the stub.
  return widened as LiquidityPool
}

function stubPosition(stub: PositionStub): Position {
  const widened: object = stub
  // SAFETY: buildSafeWithdraw only reads the fields provided by the stub.
  return widened as Position
}

function clPool(): LiquidityPool {
  return stubPool({
    lp: '0x9000000000000000000000000000000000000009',
    isCl: true,
    type: 100,
    nfpm: NFPM,
    symbol: 'CL100-WETH/USDC',
    sqrtRatio: 1n,
    token0: { tokenAddress: WETH, symbol: 'WETH', decimals: 18 },
    token1: { tokenAddress: USDC, symbol: 'USDC', decimals: 6 },
  })
}

function position(): Position {
  return stubPosition({
    id: 42n,
    pool: clPool(),
    liquidity: 1_000n,
    amountToken0: 500n,
    amountToken1: 900n,
  })
}

describe('buildSafeWithdraw', () => {
  test('emits decreaseLiquidity, collect(recipient = safe), burn as separate calls', () => {
    const plan = buildSafeWithdraw(SAFE, position(), 0.01)
    expect(plan).toHaveLength(3)
    expect(plan.every((tx) => tx.to === NFPM && tx.from === SAFE && tx.value === 0n)).toBe(true)
    const [decrease, collect, burn] = plan.map((tx) => decodeFunctionData({ abi: abis.nfpm, data: tx.data }))
    expect(decrease.functionName).toBe('decreaseLiquidity')
    expect(collect.functionName).toBe('collect')
    // SAFETY: viem decodes the named collect params struct as an object.
    const collectParams = collect.args![0] as { recipient: Address; tokenId: bigint }
    expect(collectParams.recipient).toBe(SAFE)
    expect(collectParams.tokenId).toBe(42n)
    expect(burn.functionName).toBe('burn')
    expect(burn.args).toEqual([42n])
  })

  test('rejects empty positions', () => {
    const empty = { ...position(), liquidity: 0n }
    expect(() => buildSafeWithdraw(SAFE, empty, 0.01)).toThrow('no liquidity')
  })
})

describe('buildSafeDeposit', () => {
  const quote: DepositQuote = {
    pool: clPool(),
    amountToken0: 1_000n,
    amountToken1: 2_000n,
    tickLower: -1_000,
    tickUpper: 1_000,
    sqrtPriceX96: 0n,
  }

  test('approves exact ERC20 amounts to the NFPM and mints with recipient = safe, no ether', async () => {
    const client = stubSugarClient({ checkTokenAllowance: async () => 0n })
    const plan = await buildSafeDeposit(client, SAFE, quote, 0.01)
    expect(plan).toHaveLength(3)
    expect(plan.every((tx) => tx.value === 0n)).toBe(true)
    const approvals = plan.slice(0, 2).map((tx) => decodeFunctionData({ abi: abis.erc20, data: tx.data }))
    expect(approvals.map((a) => a.functionName)).toEqual(['approve', 'approve'])
    expect(approvals[0].args).toEqual([NFPM, 1_000n])
    expect(approvals[1].args).toEqual([NFPM, 2_000n])
    const mint = decodeFunctionData({ abi: abis.nfpm, data: plan[2].data })
    expect(mint.functionName).toBe('mint')
    // SAFETY: viem decodes the named mint params struct as an object.
    const mintParams = mint.args![0] as { recipient: Address; tickLower: number; tickUpper: number }
    expect(mintParams.recipient).toBe(SAFE)
    expect(mintParams.tickLower).toBe(-1_000)
    expect(mintParams.tickUpper).toBe(1_000)
  })

  test('skips approvals already in place', async () => {
    const client = stubSugarClient({ checkTokenAllowance: async () => 10_000n })
    const plan = await buildSafeDeposit(client, SAFE, quote, 0.01)
    expect(plan).toHaveLength(1)
    expect(decodeFunctionData({ abi: abis.nfpm, data: plan[0].data }).functionName).toBe('mint')
  })
})
