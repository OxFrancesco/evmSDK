import { STOCKS, parseAllocations } from '../stocks/catalog'

export function equalWeights(weights: ReadonlyMap<string, number>): Map<string, number> {
  const included = [...weights].filter(([, weight]) => weight > 0).map(([symbol]) => symbol)
  if (included.length === 0) throw new Error('Choose stocks with Space or enter a percentage first')
  const result = new Map(weights)
  const share = Math.floor(10000 / included.length)
  included.forEach((symbol, index) => result.set(symbol, share + (index < 10000 % included.length ? 1 : 0)))
  return result
}

export function indexAllocations(weights: ReadonlyMap<string, number>, original?: string): string {
  const retained = new Set(original ? parseAllocations(original).map(({ stock }) => stock.symbol) : [])
  return STOCKS.filter((stock) => weights.has(stock.symbol) || retained.has(stock.symbol))
    .map((stock) => `${stock.symbol}=${(weights.get(stock.symbol) ?? 0) / 100}`).join(',')
}
