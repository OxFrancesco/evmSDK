import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, parseAbi, type Address } from 'viem'
import { SugarClient } from '../client'
import { stubPublicClient } from '../test-support'
import type { Quote, Token } from '../types'
import { parseAllocations, resolveStock, STOCKS, STOCK_USDC } from './catalog'
import { rebalanceIndex, stockAmount, stockTrade } from './trading'

const owner: Address = '0x1111111111111111111111111111111111111111'
const permit2: Address = '0x2222222222222222222222222222222222222222'
const usdc: Token = { chainId: 8453, chainName: 'Base', symbol: 'USDC', tokenAddress: STOCK_USDC, decimals: 6, listed: true, emerging: false }
const assets = STOCKS.map((stock) => ({ ...usdc, symbol: stock.symbol, tokenAddress: stock.address, decimals: 18 }))

class StockClient extends SugarClient {
  balances = new Map<string, bigint>([[STOCK_USDC, 1000_000000n]])
  quoted: Quote[] = []
  constructor(chain = 8453) {
    super(chain, { account: owner, env: {}, publicClient: stubPublicClient({ readContract: async ({ functionName, args }) => {
      if (functionName === 'PERMIT2') return permit2
      // Each buy fits the old allowance, but two buys exceed it.
      if (functionName === 'allowance') return args?.length === 3 ? [60_000000n, 9999999999, 0] : 60_000000n
      return 0n
    } }) })
  }
  override getToken(reference: string): Promise<Token | undefined> { return Promise.resolve([usdc, ...assets].find((asset) => asset.tokenAddress === reference)) }
  override getTokenBalance(asset: Token): Promise<bigint> { return Promise.resolve(this.balances.get(asset.tokenAddress) ?? 0n) }
  override getQuote(from: Token, to: Token, amount: bigint): Promise<Quote | undefined> {
    // All stocks cost exactly 100 USDC in this deterministic market.
    const amountOut = from.symbol === 'USDC' ? amount * 10n ** 12n / 100n : amount * 100n / 10n ** 12n
    const result: Quote = { amountOut, input: { fromToken: from, toToken: to, amountIn: amount, path: [{ reversed: false, pool: {
      chainId: 8453, chainName: 'Base', lp: '0x3333333333333333333333333333333333333333',
      token0Address: STOCK_USDC, token1Address: STOCKS[0].address, type: -1, isCl: false, isBasic: true, isStable: false,
    } }] } }
    this.quoted.push(result)
    return Promise.resolve(result)
  }
}

describe('stock allocation boundary', () => {
  test('resolves issuer tickers and rejects duplicates, unknowns and invalid totals', () => {
    expect(resolveStock('nvda')).toEqual(STOCKS[0])
    expect(parseAllocations('NVDA=33.33,AAPL=66.67').map((row) => row.weightBps)).toEqual([3333, 6667])
    for (const input of ['NVDA=50,NVDAc=50', 'NVDA=99', 'NVDA=-1,AAPL=101', 'FAKE=100', 'NVDA=NaN', 'NVDA=100=0']) expect(() => parseAllocations(input)).toThrow()
  })
  test('rejects precision loss, zero trades and scientific notation', () => {
    expect(stockAmount('0.000001', 6)).toBe(1n)
    expect(stockAmount('0', 6, true)).toBe(0n)
    for (const amount of ['0.0000001', '0', '-1', '1e9', 'NaN', 'Infinity']) expect(() => stockAmount(amount, 6)).toThrow()
  })
})

describe('stock trading and rebalancing', () => {
  test('buy uses USDC units and sell uses stock units', async () => {
    const client = new StockClient()
    expect((await stockTrade(client, 'buy', 'NVDA', '25', 0.01)).trades[0]).toMatchObject({ amount: '25', expected: '0.25', minimum: '0.2475' })
    client.balances.set(STOCKS[0].address, 10n ** 18n)
    expect((await stockTrade(client, 'sell', 'NVDAc', '0.5', 0.01)).trades[0]).toMatchObject({ from: 'NVDAc', to: 'USDC', amount: '0.5', expected: '50' })
  })
  test('buys a new index with one atomic execute and aggregate USDC approvals', async () => {
    const client = new StockClient()
    const result = await rebalanceIndex(client, 'NVDA=50,AAPL=50', '100', 0.01)
    expect(result.trades.map((trade) => trade.amount)).toEqual(['50', '50'])
    expect(result.transaction_steps.map((step) => step.role)).toEqual(['approval', 'approval', 'action'])
    const approval = decodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount)']), data: result.transactions[0].data })
    expect(approval.args?.[1]).toBe(100_000000n)
    const execution = decodeFunctionData({ abi: parseAbi(['function execute(bytes commands,bytes[] inputs)']), data: result.transactions[2].data })
    expect(execution.args?.[0]).toBe('0x0808')
    expect(execution.args?.[1]).toHaveLength(2)
  })
  test('sells first and buys using only guaranteed proceeds, preserving unrelated USDC', async () => {
    const client = new StockClient()
    client.balances.set(STOCKS[0].address, 10n ** 18n)
    const result = await rebalanceIndex(client, 'NVDA=50,AAPL=50', '0', 0.01)
    expect(result.trades).toMatchObject([
      { from: 'NVDAc', to: 'USDC', amount: '0.5', minimum: '49.5' },
      { from: 'USDC', to: 'AAPLc', amount: '49.5' },
    ])
    expect(result.total_usdc).toBe('100')
  })
  test('zero weight exits a holding, and already balanced portfolios do nothing', async () => {
    const client = new StockClient()
    client.balances.set(STOCKS[0].address, 10n ** 18n)
    const exit = await rebalanceIndex(client, 'NVDA=0,AAPL=100', '0', 0.01)
    expect(exit.trades[0].amount).toBe('1')
    client.balances.set(STOCKS[1].address, 10n ** 18n)
    const noop = await rebalanceIndex(client, 'NVDA=50,AAPL=50', '0', 0.01)
    expect(noop.transactions).toEqual([])
  })
  test('rejects unsupported chains, overspending and missing routes before building', async () => {
    await expect(stockTrade(new StockClient(10), 'buy', 'NVDA', '1', 0.01)).rejects.toThrow('Base only')
    const client = new StockClient()
    await expect(rebalanceIndex(client, 'NVDA=100', '1001', 0.01)).rejects.toThrow('Insufficient')
    await expect(stockTrade(client, 'sell', 'NVDA', '1', 0.01)).rejects.toThrow('Insufficient')
    await expect(rebalanceIndex(client, 'NVDA=100', '1', 1)).rejects.toThrow('Slippage')
    client.getQuote = () => Promise.resolve(undefined)
    await expect(rebalanceIndex(client, 'NVDA=100', '100', 0.01)).rejects.toThrow('No executable route')
  })
})
