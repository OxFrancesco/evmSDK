import { STOCKS } from '../stocks/catalog'
import * as Predicate from 'effect/Predicate'
import type { SugarAction, SugarParameter, SugarParameters } from '../contracts'

/**
 * Form definitions for every Sugar action, mirroring the flags in
 * src/cli/action-commands.ts. The TUI defaults `use_decimals` to on because
 * humans think in token units, not wei; the headless CLI keeps raw units.
 */

export type FieldKind = 'text' | 'number' | 'boolean' | 'choice' | 'token'

export type FieldSpec = {
  name: string
  label: string
  kind: FieldKind
  required?: boolean
  choices?: readonly string[]
  placeholder?: string
  initial?: string | boolean
  help?: string
}

const poolType: FieldSpec = { name: 'pool_type', label: 'Pool type', kind: 'choice', choices: ['any', 'cl', 'stable', 'volatile'], help: 'Filter or select the pool flavor' }
const pool: FieldSpec = { name: 'pool', label: 'Pool', kind: 'text', placeholder: '0x pool address', help: 'Pool (liquidity pair) address' }
const position: FieldSpec = { name: 'position', label: 'Position id', kind: 'text', placeholder: 'id from positions', help: 'Position id (browse them in Positions)' }
/** Token fields open a fuzzy picker over the whitelisted catalog on Enter; typing still works. */
const tokenField = (name: string, label: string, required = false): FieldSpec => ({
  name, label, kind: 'token', required,
  placeholder: 'type a symbol, or press enter to browse',
  help: 'Enter browses whitelisted tokens with fuzzy search; typing a symbol or 0x address also works',
})
const useDecimals: FieldSpec = { name: 'use_decimals', label: 'Human units', kind: 'boolean', initial: true, help: 'Read amounts as 0.1 ETH instead of raw wei' }
const slippage: FieldSpec = { name: 'slippage', label: 'Slippage', kind: 'number', placeholder: '0.01 = 1%', help: 'Tolerance between 0 and 1' }
const deadline: FieldSpec = { name: 'deadline_minutes', label: 'Deadline (min)', kind: 'number', placeholder: '30' }
const burn: FieldSpec = { name: 'burn', label: 'Burn NFT', kind: 'boolean', initial: false, help: 'Burn the emptied CL position NFT' }
const unwrapNative: FieldSpec = { name: 'unwrap_native', label: 'Unwrap native', kind: 'boolean', initial: false, help: 'Unwrap the wrapped native leg back to ETH' }

const stockField: FieldSpec = { name: 'stock', label: 'Stock', kind: 'choice', choices: STOCKS.map((stock) => stock.symbol) }

export const ACTION_FORMS = {
  stocks: [],
  stock_buy: [stockField, { name: 'amount', label: 'Spend USDC', kind: 'text', required: true }, slippage],
  stock_sell: [stockField, { name: 'amount', label: 'Token units', kind: 'text', required: true }, slippage],
  index_rebalance: [
    { name: 'allocations', label: 'Target weights', kind: 'text', required: true, placeholder: 'NVDAc=50,AAPLc=50', help: 'All wallet holdings of these stocks are included. Keep a stock at 0% to exit it.' },
    { name: 'cash', label: 'Add USDC', kind: 'text', initial: '0', help: 'Only this USDC amount is added. Other wallet USDC stays untouched.' },
    slippage,
  ],
  positions: [
    { name: 'owner', label: 'Owner', kind: 'text', placeholder: 'defaults to connected wallet' },
  ],
  pools: [
    tokenField('token0', 'Token 0'),
    tokenField('token1', 'Token 1'),
    poolType,
    { name: 'full', label: 'Full details', kind: 'boolean', initial: true, help: 'Hydrate reserves, TVL, and emissions' },
    { name: 'limit', label: 'Limit', kind: 'number', placeholder: '20' },
  ],
  epochs_latest: [poolType],
  epochs: [
    { name: 'lp', label: 'Pool', kind: 'text', required: true, placeholder: '0x pool address' },
    poolType,
    { name: 'limit', label: 'Limit', kind: 'number', placeholder: '10' },
    { name: 'offset', label: 'Offset', kind: 'number', placeholder: '0' },
  ],
  quote: [
    tokenField('from_token', 'From token', true),
    tokenField('to_token', 'To token', true),
    { name: 'amount', label: 'Amount', kind: 'text', required: true, placeholder: '0.1' },
    useDecimals,
  ],
  swap: [
    tokenField('from_token', 'From token', true),
    tokenField('to_token', 'To token', true),
    { name: 'amount', label: 'Amount', kind: 'text', required: true, placeholder: '0.1' },
    slippage,
    useDecimals,
  ],
  deposit: [
    { ...pool, help: 'Pass a pool, or the token pair below' },
    tokenField('token0', 'Token 0'),
    tokenField('token1', 'Token 1'),
    poolType,
    { name: 'amount0', label: 'Amount 0', kind: 'text', placeholder: 'amount of token0' },
    { name: 'amount1', label: 'Amount 1', kind: 'text', placeholder: 'amount of token1' },
    { name: 'tick_spacing', label: 'Tick spacing', kind: 'number', placeholder: 'new CL pools only' },
    { name: 'price_lower', label: 'Price lower', kind: 'number', placeholder: 'CL range as price' },
    { name: 'price_upper', label: 'Price upper', kind: 'number', placeholder: 'CL range as price' },
    { name: 'tick_lower', label: 'Tick lower', kind: 'number', placeholder: 'CL range as tick' },
    { name: 'tick_upper', label: 'Tick upper', kind: 'number', placeholder: 'CL range as tick' },
    { name: 'initial_price', label: 'Initial price', kind: 'number', placeholder: 'uninitialized CL pools' },
    slippage,
    deadline,
    useDecimals,
  ],
  withdraw: [
    pool,
    position,
    { name: 'fraction', label: 'Fraction', kind: 'text', placeholder: '0.5 = half, empty = all' },
    burn,
    { name: 'collect', label: 'Collect fees', kind: 'boolean', initial: true, help: 'Collect owed fees while withdrawing (CL)' },
    unwrapNative,
    slippage,
    deadline,
  ],
  stake: [pool, position],
  unstake: [
    pool,
    position,
    { name: 'amount', label: 'Amount', kind: 'text', placeholder: 'LP amount, empty = everything' },
  ],
  claim_emissions: [pool, position],
  claim_fees: [pool, position, burn, unwrapNative],
  create_venft: [
    { name: 'amount', label: 'Amount', kind: 'text', required: true, placeholder: 'AERO/VELO to lock' },
    { name: 'lock_duration_seconds', label: 'Lock (seconds)', kind: 'number', required: true, placeholder: '31536000 = 1 year' },
    useDecimals,
  ],
} satisfies Record<SugarAction, FieldSpec[]>

export const ACTION_TITLES = {
  stocks: 'Stocks', stock_buy: 'Buy stock', stock_sell: 'Sell stock', index_rebalance: 'Rebalance index',
  quote: 'Quote',
  swap: 'Swap',
  pools: 'Pools',
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  positions: 'Positions',
  stake: 'Stake',
  unstake: 'Unstake',
  claim_emissions: 'Claim emissions',
  claim_fees: 'Claim fees',
  create_venft: 'Create veNFT',
  epochs_latest: 'Latest epochs',
  epochs: 'Epoch history',
} satisfies Record<SugarAction, string>

export const ACTION_DESCRIPTIONS = {
  stocks: 'Tokenized stocks on Base', stock_buy: 'Buy with USDC', stock_sell: 'Sell token units for USDC', index_rebalance: 'Trade wallet holdings toward target weights',
  quote: 'Best route and price impact, no transactions',
  swap: 'Swap tokens through the best route',
  pools: 'Browse liquidity pools',
  deposit: 'Add liquidity to a pool',
  withdraw: 'Remove liquidity from a position',
  positions: 'List your liquidity positions',
  stake: 'Stake a position in its gauge',
  unstake: 'Unstake a position from its gauge',
  claim_emissions: 'Claim gauge emissions',
  claim_fees: 'Claim trading fees',
  create_venft: 'Lock AERO/VELO for voting power',
  epochs_latest: 'Votes, emissions, and fees per pool',
  epochs: 'Voting epoch history for one pool',
} satisfies Record<SugarAction, string>

export type FormValues = Record<string, string | boolean>

function initialValue(field: FieldSpec): string | boolean {
  if (field.kind === 'boolean') return field.initial === true
  if (Predicate.isString(field.initial)) return field.initial
  return field.kind === 'choice' ? field.choices![0] : ''
}

export function initialValues(fields: FieldSpec[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.name, initialValue(field)]))
}

/** Coerce the form into Sugar parameters, dropping empty optionals. */
export function buildParameters(fields: FieldSpec[], values: FormValues, chain: number): SugarParameters {
  const parameters: SugarParameters = { chain }
  for (const field of fields) {
    const raw = values[field.name]
    let value: SugarParameter | undefined
    if (field.kind === 'boolean') value = raw === true ? true : field.initial === true ? false : undefined
    else if (field.kind === 'choice') value = raw === 'any' || raw === '' ? undefined : String(raw)
    else if (Predicate.isString(raw) && raw.trim() !== '') {
      if (field.kind === 'number') {
        const parsed = Number(raw.trim())
        if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`)
        value = parsed
      } else value = raw.trim()
    }
    if (value === undefined) {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    parameters[field.name] = value
  }
  return parameters
}
