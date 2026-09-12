import { describe, expect, test } from 'bun:test'
import { dedupeTokens, describeToken, resolveTokenReference, searchTokens, toTokenChoice } from './token-catalog'
import type { Token } from './types'

function makeToken(symbol: string, address: string, decimals = 18, overrides: Partial<Token> = {}): Token {
  return {
    chainId: 8453,
    chainName: 'Base',
    tokenAddress: address,
    symbol,
    decimals,
    listed: true,
    emerging: false,
    ...overrides,
  }
}

const CATALOG = [
  makeToken('ETH', 'ETH', 18, { wrappedTokenAddress: '0x4200000000000000000000000000000000000006' }),
  makeToken('AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631'),
  makeToken('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
  makeToken('USDC.e', '0xd9aAEc86B65D86fF8077BFe4ECE9E1cc78d43a14', 6),
  makeToken('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8),
]

describe('token catalog search', () => {
  test('exact symbols beat partial matches regardless of position', () => {
    const results = searchTokens(CATALOG, 'usdc')
    expect(results[0]?.symbol).toBe('USDC')
  })

  test('empty queries keep catalog order and cap the page size', () => {
    const many = Array.from({ length: 30 }, (_, index) => makeToken(`TOK${index}`, `0x${String(index).padStart(40, '0')}`))
    expect(searchTokens(many, '')).toHaveLength(12)
    expect(searchTokens(many, '')[0]?.symbol).toBe('TOK0')
  })

  test('address prefixes find tokens without exact case', () => {
    const results = searchTokens(CATALOG, '0x833589f')
    expect(results.map((token) => token.symbol)).toEqual(['USDC'])
  })

  test('fuzzy queries survive missing and transposed characters', () => {
    expect(searchTokens(CATALOG, 'usdc.e').some((token) => token.symbol === 'USDC.e')).toBe(true)
    expect(searchTokens(CATALOG, 'cbbtc')[0]?.symbol).toBe('cbBTC')
  })

  test('ties break toward shorter canonical symbols', () => {
    const variants = [
      makeToken('WETH', '0x4200000000000000000000000000000000000006'),
      makeToken('WETHX', '0x1111111111111111111111111111111111111111'),
    ]
    expect(searchTokens(variants, 'weth')[0]?.symbol).toBe('WETH')
  })

  test('duplicate contracts collapse to one entry', () => {
    const duplicate = [CATALOG[2]!, CATALOG[2]!]
    expect(dedupeTokens(duplicate)).toHaveLength(1)
  })
})

describe('token reference resolution', () => {
  test('exact addresses resolve uniquely across case', () => {
    const { exact } = resolveTokenReference(CATALOG, CATALOG[2]!.tokenAddress.toUpperCase())
    expect(exact?.symbol).toBe('USDC')
  })

  test('unique symbols resolve exactly', () => {
    const { exact } = resolveTokenReference(CATALOG, 'aero')
    expect(exact?.symbol).toBe('AERO')
  })

  test('true duplicate symbols return candidates instead of guessing', () => {
    const cloned = [
      makeToken('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
      makeToken('USDC', '0xd9aAEc86B65D86fF8077BFe4ECE9E1cc78d43a14', 6),
    ]
    const { exact, candidates } = resolveTokenReference(cloned, 'usdc')
    expect(exact).toBeUndefined()
    expect(candidates).toHaveLength(2)
  })

  test('empty references resolve nothing', () => {
    expect(resolveTokenReference(CATALOG, '').candidates).toEqual([])
  })
})

describe('token choice rendering', () => {
  test('native tokens are tagged and show their wrapped address', () => {
    const choice = toTokenChoice(CATALOG[0]!)
    expect(choice.title).toBe('ETH')
    expect(choice.description).toContain('native')
    expect(choice.description).toContain('wrapped 0x4200…0006')
  })

  test('emerging flags show up next to the symbol', () => {
    expect(describeToken(makeToken('NEW', '0x2222222222222222222222222222222222222222', 18, { emerging: true }))).toContain('emerging')
  })
})
