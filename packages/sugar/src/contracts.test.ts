import { describe, expect, test } from 'bun:test'
import { isSugarAction, SUGAR_ACTIONS } from './contracts'

describe('Sugar action contract', () => {
  test('exposes the CLI action vocabulary without loading the SDK runtime', () => {
    expect(SUGAR_ACTIONS).toEqual([
      'stocks',
      'deposit',
      'positions',
      'pools',
      'epochs_latest',
      'epochs',
      'withdraw',
      'stake',
      'unstake',
      'claim_emissions',
      'claim_fees',
      'create_venft',
      'quote',
      'swap',
      'stock_buy',
      'stock_sell',
      'index_rebalance',
    ])
    expect(isSugarAction('quote')).toBe(true)
    expect(isSugarAction('create_venft')).toBe(true)
    expect(isSugarAction('send-private-key')).toBe(false)
  })
})
