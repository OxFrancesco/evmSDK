import type { Address } from 'viem'

export const STOCK_CHAIN = 8453
export const STOCK_USDC: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const STOCK_SOURCE = 'https://dromos.kitchen/dashboards/coinbase-tokenized-stocks'

export const STOCKS = [
  { symbol: 'NVDAc', name: 'NVIDIA', address: '0xb20000000000000000000078ee7ce2fe4908108c' },
  { symbol: 'AAPLc', name: 'Apple', address: '0xb200000000000000000000c2e324d24d7eecd1fb' },
  { symbol: 'GOOGLc', name: 'Alphabet', address: '0xb2000000000000000000002d0ba3164cc74f58b7' },
  { symbol: 'METAc', name: 'Meta', address: '0xb2000000000000000000008bc8786b856e61707c' },
  { symbol: 'AMZNc', name: 'Amazon', address: '0xb200000000000000000000d9192b6b456483c2e8' },
  { symbol: 'MSFTc', name: 'Microsoft', address: '0xb200000000000000000000ab99cfa739e253872b' },
  { symbol: 'TSLAc', name: 'Tesla', address: '0xb2000000000000000000001e800a7f5189430cd0' },
  { symbol: 'MSTRc', name: 'Strategy', address: '0xb2000000000000000000004884b426556b92883d' },
  { symbol: 'SNDKc', name: 'Sandisk', address: '0xb200000000000000000000397293cb8cda9a10c5' },
  { symbol: 'SPCXc', name: 'SpaceX', address: '0xb2000000000000000000007b9fcbd005511acbd5' },
] satisfies { symbol: string; name: string; address: Address }[]

export type Stock = (typeof STOCKS)[number]

export function resolveStock(reference: string): Stock {
  const key = reference.trim().toLowerCase()
  const stock = STOCKS.find((item) => [item.symbol.toLowerCase(), item.symbol.slice(0, -1).toLowerCase(), item.address].includes(key))
  if (!stock) throw new Error(`Unknown stock ${reference}. Use aero stocks list.`)
  return stock
}

export type StockAllocation = { stock: Stock; weightBps: number }

export function parseAllocations(text: string): StockAllocation[] {
  const allocations = text.split(',').map((entry) => {
    const [symbol, weight, extra] = entry.trim().split('=')
    if (!symbol || !weight || extra !== undefined || !/^\d+(\.\d{1,2})?$/.test(weight)) {
      throw new Error('Use SYMBOL=percent, for example NVDAc=50,AAPLc=50')
    }
    const weightBps = Math.round(Number(weight) * 100)
    if (weightBps < 0 || weightBps > 10000) throw new Error('Each weight must be between 0 and 100%')
    return { stock: resolveStock(symbol), weightBps }
  })
  if (new Set(allocations.map((item) => item.stock.address)).size !== allocations.length) throw new Error('A stock can appear only once')
  if (allocations.reduce((sum, item) => sum + item.weightBps, 0) !== 10000) throw new Error('Weights must total 100%')
  return allocations
}

export function formatAllocations(allocations: StockAllocation[]): string {
  return allocations.map(({ stock, weightBps }) => `${stock.symbol}=${weightBps / 100}`).join(',')
}
