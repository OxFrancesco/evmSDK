import { formatUnits, parseUnits } from 'viem'
import type { SugarClient } from '../client'
import { applySlippage } from '../helpers'
import type { Quote, Token } from '../types'
import { parseAllocations, resolveStock, STOCK_CHAIN, STOCK_USDC, STOCKS } from './catalog'

export function stockAmount(text: string, decimals: number, allowZero = false): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0) > decimals || text.length > 100) throw new Error(`Amount must be a decimal with at most ${decimals} decimal places`)
  const amount = parseUnits(text, decimals)
  if (amount < 0n || (!allowZero && amount === 0n)) throw new Error('Amount must be positive')
  return amount
}

function requireBase(client: SugarClient): void {
  if (client.settings.chainId !== STOCK_CHAIN) throw new Error('Tokenized stocks are available on Base only, chain 8453')
}

async function token(client: SugarClient, address: string): Promise<Token> {
  const value = await client.getToken(address)
  if (!value || value.tokenAddress.toLowerCase() !== address.toLowerCase()) throw new Error(`Token unavailable: ${address}`)
  return value
}

async function quote(client: SugarClient, from: Token, to: Token, amount: bigint): Promise<Quote> {
  const result = await client.getQuote(from, to, amount)
  if (!result || result.amountOut <= 0n) throw new Error(`No executable route for ${from.symbol} to ${to.symbol}`)
  return result
}

export async function stockMarket(client: SugarClient) {
  requireBase(client)
  const usdc = await token(client, STOCK_USDC)
  return Promise.all(STOCKS.map(async (stock) => {
    try {
      const asset = await token(client, stock.address)
      const [price, balance] = await Promise.all([
        quote(client, asset, usdc, 10n ** BigInt(asset.decimals)),
        client.account ? client.getTokenBalance(asset) : Promise.resolve(undefined),
      ])
      return { ...stock, price_usdc: formatUnits(price.amountOut, usdc.decimals), balance: balance === undefined ? null : formatUnits(balance, asset.decimals), error: null }
    } catch (cause) {
      return { ...stock, price_usdc: null, balance: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }))
}

export async function stockTrade(client: SugarClient, side: 'buy' | 'sell', symbol: string, amountText: string, slippage: number) {
  requireBase(client)
  const stock = resolveStock(symbol)
  const [asset, cash] = await Promise.all([token(client, stock.address), token(client, STOCK_USDC)])
  const [from, to] = side === 'buy' ? [cash, asset] : [asset, cash]
  const amount = stockAmount(amountText, from.decimals)
  if (await client.getTokenBalance(from) < amount) throw new Error(`Insufficient ${from.symbol} balance`)
  const trade = await quote(client, from, to, amount)
  return buildStockPlan(client, [trade], slippage, [])
}

export async function rebalanceIndex(client: SugarClient, allocationText: string, cashText: string, slippage: number) {
  requireBase(client)
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) throw new Error('Slippage must be at least 0 and less than 1')
  const allocations = parseAllocations(allocationText)
  const cash = await token(client, STOCK_USDC)
  const contribution = stockAmount(cashText, cash.decimals, true)
  if (await client.getTokenBalance(cash) < contribution) throw new Error('Insufficient USDC for the cash contribution')
  const holdings = await Promise.all(allocations.map(async ({ stock, weightBps }) => {
    const asset = await token(client, stock.address)
    const balance = await client.getTokenBalance(asset)
    const value = balance > 0n ? (await quote(client, asset, cash, balance)).amountOut : 0n
    return { stock, weightBps, asset, balance, value }
  }))
  const total = holdings.reduce((sum, holding) => sum + holding.value, contribution)
  if (total === 0n) throw new Error('No index holdings. Add a USDC contribution to fund this index.')
  const rows = holdings.map((holding) => ({ ...holding, target: total * BigInt(holding.weightBps) / 10000n }))
  const quotes: Quote[] = []
  let budget = contribution
  for (const row of rows) {
    if (row.value <= row.target) continue
    const amount = row.balance * (row.value - row.target) / row.value
    if (amount === 0n) continue
    const sale = await quote(client, row.asset, cash, amount)
    quotes.push(sale)
    budget += applySlippage(sale.amountOut, slippage)
  }
  const deficits = rows.map((row) => ({ ...row, deficit: row.target > row.value ? row.target - row.value : 0n }))
  const needed = deficits.reduce((sum, row) => sum + row.deficit, 0n)
  const spend = budget < needed ? budget : needed
  for (const row of deficits) {
    if (row.deficit === 0n || needed === 0n) continue
    const amount = spend * row.deficit / needed
    if (amount === 0n) continue
    quotes.push(await quote(client, cash, row.asset, amount))
  }
  const allocation = rows.map((row) => ({
    symbol: row.stock.symbol,
    balance: formatUnits(row.balance, row.asset.decimals),
    current_usdc: formatUnits(row.value, cash.decimals),
    current_pct: total > 0n ? Number(row.value * 10000n / total) / 100 : 0,
    target_pct: row.weightBps / 100,
    target_usdc: formatUnits(row.target, cash.decimals),
  }))
  return { ...(await buildStockPlan(client, quotes, slippage, allocation)), cash_contribution: cashText, total_usdc: formatUnits(total, cash.decimals) }
}

async function buildStockPlan(client: SugarClient, quotes: Quote[], slippage: number, allocation: { symbol: string; balance: string; current_usdc: string; current_pct: number; target_pct: number; target_usdc: string }[]) {
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) throw new Error('Slippage must be at least 0 and less than 1')
  const transactions = await client.swapBasketFromQuotes(quotes, slippage)
  return {
    transactions,
    transaction_steps: transactions.map((transaction, index) => ({ role: index === transactions.length - 1 ? 'action' : 'approval', transaction })),
    allocation,
    trades: quotes.map((item) => ({
      from_address: item.input.fromToken.tokenAddress,
      to_address: item.input.toToken.tokenAddress,
      amount_raw: item.input.amountIn.toString(),
      minimum_raw: applySlippage(item.amountOut, slippage).toString(),
      from: item.input.fromToken.symbol,
      to: item.input.toToken.symbol,
      amount: formatUnits(item.input.amountIn, item.input.fromToken.decimals),
      expected: formatUnits(item.amountOut, item.input.toToken.decimals),
      minimum: formatUnits(applySlippage(item.amountOut, slippage), item.input.toToken.decimals),
    })),
    slippage,
  }
}
