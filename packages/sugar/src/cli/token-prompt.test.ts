import { describe, expect, test } from 'bun:test'
import { filterChoices, moveIndex } from './token-prompt'
import type { TokenChoice } from '../token-catalog'

function choice(title: string, description = ''): TokenChoice {
  return {
    token: {
      chainId: 8453,
      chainName: 'Base',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      symbol: title,
      decimals: 18,
      listed: true,
      emerging: false,
    },
    title,
    description,
  }
}

const CHOICES = [choice('ETH'), choice('WETH', '0x4200…0006 · 18 decimals'), choice('USDC', '0x8335…2913 · 6 decimals')]

describe('token picker filtering', () => {
  test('empty queries keep catalog order', () => {
    expect(filterChoices(CHOICES, '').map((entry) => entry.title)).toEqual(['ETH', 'WETH', 'USDC'])
  })

  test('queries fuzzy-match titles and descriptions', () => {
    expect(filterChoices(CHOICES, 'usdc').map((entry) => entry.title)).toEqual(['USDC'])
    expect(filterChoices(CHOICES, 'wrapped').map((entry) => entry.title)).toEqual([])
    expect(filterChoices(CHOICES, '0x4200').map((entry) => entry.title)).toEqual(['WETH'])
  })

  test('unmatched queries empty the list instead of guessing', () => {
    expect(filterChoices(CHOICES, 'zzzz')).toEqual([])
  })
})

describe('token picker cursor movement', () => {
  test('movement clamps to the list bounds', () => {
    expect(moveIndex(0, -1, 3)).toBe(0)
    expect(moveIndex(2, 1, 3)).toBe(2)
    expect(moveIndex(1, -1, 3)).toBe(0)
    expect(moveIndex(1, 1, 3)).toBe(2)
  })

  test('empty lists stay at index zero', () => {
    expect(moveIndex(5, 1, 0)).toBe(0)
  })
})
