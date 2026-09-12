export const SUGAR_ACTIONS = [
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
] as const

export type SugarAction = (typeof SUGAR_ACTIONS)[number]
export type SugarParameter = string | number | boolean
export type SugarParameters = Record<string, SugarParameter>

export function isSugarAction(value: string): value is SugarAction {
  return SUGAR_ACTIONS.some((action) => action === value)
}

/** The subset of actions that build transactions (executable plans). */
export const SUGAR_TX_ACTIONS = [
  'swap',
  'stock_buy',
  'stock_sell',
  'index_rebalance',
  'deposit',
  'withdraw',
  'stake',
  'unstake',
  'claim_emissions',
  'claim_fees',
  'create_venft',
] as const

export type SugarTxAction = (typeof SUGAR_TX_ACTIONS)[number]

export function isSugarTxAction(value: string): value is SugarTxAction {
  return SUGAR_TX_ACTIONS.some((action) => action === value)
}
