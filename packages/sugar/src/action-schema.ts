import { STOCKS } from './stocks/catalog'
import { isSugarTxAction, type SugarAction } from './contracts'

/**
 * The one description of every Sugar action's parameters. The CLI derives
 * its flags and help from it, the TUI derives its forms, the headless
 * `sugar-ts` entrypoint derives flag coercion, and `validateSugarRequest`
 * derives the allowed/required sets. Add a parameter here and every client
 * gets it.
 *
 * `chain` and `wallet` are context, not listed per action: every action takes
 * `--chain`, and transaction actions plus `positions`/`stocks` take `--wallet`
 * (see `acceptsWallet`). The TUI fills both from its own state.
 */

export type ParameterKind =
  | 'address'
  | 'boolean'
  | 'choice'
  | 'decimal_string'
  | 'integer'
  | 'integer_string'
  | 'number'
  | 'string'
  | 'token'

export type ParameterSpec = {
  name: string
  kind: ParameterKind
  /** Short label for a form row. */
  label: string
  /** One sentence shown as CLI flag help and as the TUI help line. */
  description: string
  required?: boolean
  choices?: readonly string[]
  /** Example value: TUI placeholder and CLI metavar. */
  placeholder?: string
  /**
   * Boolean the action layer treats as on when omitted. The CLI exposes it as
   * `--no-<name>` and only sends an explicit `false`; the TUI starts it on.
   */
  default?: true
  /** Boolean the TUI starts on for convenience while the CLI keeps it off. */
  tuiDefault?: true
  /**
   * TUI progressive disclosure. `new-pool` rows show while no pool is chosen,
   * `cl` rows with CL pools, `new-cl-pool` rows for a new CL pool, and
   * `advanced` rows behind "More options".
   */
  group?: 'new-pool' | 'cl' | 'new-cl-pool' | 'advanced'
  /** TUI Enter opens a picker over live data instead of free text. */
  picker?: 'pool' | 'position'
}

export type ActionExample = { command: string; description: string }

export type ActionSpec = {
  title: string
  description: string
  parameters: readonly ParameterSpec[]
  examples?: readonly ActionExample[]
}

const poolType: ParameterSpec = { name: 'pool_type', kind: 'choice', label: 'Pool type', choices: ['cl', 'stable', 'volatile'], description: 'Filter or select the pool flavor' }
const token = (name: string, label: string, description: string, required = false): ParameterSpec => ({
  name, kind: 'token', label, description, required, placeholder: 'symbol or 0x address',
})
const pool: ParameterSpec = { name: 'pool', kind: 'address', label: 'Pool', picker: 'position', placeholder: '0x address', description: 'Pool of the position (pick from your positions)' }
const position: ParameterSpec = { name: 'position', kind: 'integer_string', label: 'Position id', picker: 'position', placeholder: 'id', description: 'Position id (list yours with: aero positions)' }
const useDecimals: ParameterSpec = { name: 'use_decimals', kind: 'boolean', label: 'Human units', tuiDefault: true, description: 'Read amounts as human units (0.1 ETH) instead of raw wei' }
const slippage: ParameterSpec = { name: 'slippage', kind: 'number', label: 'Slippage', group: 'advanced', placeholder: '0.01', description: 'Slippage tolerance between 0 and 1 (0.01 = 1%)' }
const deadline: ParameterSpec = { name: 'deadline_minutes', kind: 'integer', label: 'Deadline (min)', group: 'advanced', placeholder: '30', description: 'Transaction deadline in minutes (default 30)' }
const burn: ParameterSpec = { name: 'burn', kind: 'boolean', label: 'Burn NFT', description: 'Burn the emptied CL position NFT' }
const unwrapNative: ParameterSpec = { name: 'unwrap_native', kind: 'boolean', label: 'Unwrap native', description: 'Unwrap the wrapped native leg back to the native token' }
const limit = (fallback: string, description: string): ParameterSpec => ({ name: 'limit', kind: 'integer', label: 'Limit', placeholder: fallback, description })
/** A string, not a `choice`: `resolveStock` also accepts `NVDA` and addresses. The TUI still offers the catalog. */
const stock: ParameterSpec = { name: 'stock', kind: 'string', label: 'Stock', required: true, choices: STOCKS.map((entry) => entry.symbol), placeholder: 'NVDAc', description: `Stock token: ${STOCKS.map((entry) => entry.symbol).join(', ')}` }

export const ACTION_SCHEMA = {
  stocks: {
    title: 'Stocks',
    description: 'Tokenized stocks on Base with prices and your balances',
    parameters: [],
  },
  stock_buy: {
    title: 'Buy stock',
    description: 'Buy a tokenized stock with USDC',
    parameters: [
      stock,
      { name: 'amount', kind: 'string', label: 'Spend USDC', required: true, placeholder: '100', description: 'USDC to spend' },
      slippage,
    ],
  },
  stock_sell: {
    title: 'Sell stock',
    description: 'Sell tokenized stock units for USDC',
    parameters: [
      stock,
      { name: 'amount', kind: 'string', label: 'Token units', required: true, placeholder: '1.5', description: 'Stock token units to sell' },
      slippage,
    ],
  },
  index_rebalance: {
    title: 'Rebalance index',
    description: 'Trade wallet holdings toward target weights',
    parameters: [
      { name: 'allocations', kind: 'string', label: 'Target weights', required: true, placeholder: 'NVDAc=50,AAPLc=50', description: 'Target percentages; all wallet holdings of these stocks are included, and 0% exits a stock' },
      { name: 'cash', kind: 'string', label: 'Add USDC', placeholder: '0', description: 'USDC added on top of existing holdings; other wallet USDC stays untouched' },
      slippage,
    ],
  },
  positions: {
    title: 'Positions',
    description: 'List your liquidity positions (basic and concentrated)',
    parameters: [
      { name: 'owner', kind: 'address', label: 'Owner', placeholder: '0x address', description: 'List positions for another address (defaults to the connected wallet)' },
    ],
    examples: [{ command: 'aero positions', description: 'Positions for the connected wallet on Base' }],
  },
  pools: {
    title: 'Pools',
    description: 'Browse liquidity pools, optionally filtered by tokens',
    parameters: [
      token('token0', 'Token 0', 'First pool token'),
      token('token1', 'Token 1', 'Second pool token'),
      poolType,
      { name: 'full', kind: 'boolean', label: 'Full details', tuiDefault: true, description: 'Include tokens, reserves, TVL, and emissions' },
      limit('20', 'Return at most this many pools (1-100)'),
    ],
    examples: [{ command: 'aero pools --token0 ETH --token1 USDC --full --limit 5', description: 'Top ETH/USDC pools with reserves and TVL' }],
  },
  epochs_latest: {
    title: 'Latest epochs',
    description: 'Latest voting epoch (votes, emissions, fees, incentives) per pool',
    parameters: [poolType],
  },
  epochs: {
    title: 'Epoch history',
    description: 'Voting epoch history for one pool',
    parameters: [
      { name: 'lp', kind: 'address', label: 'Pool', required: true, picker: 'pool', placeholder: '0x address', description: 'Pool address to inspect' },
      poolType,
      limit('10', 'Epochs to return (default 10)'),
      { name: 'offset', kind: 'integer', label: 'Offset', placeholder: '0', description: 'Skip this many epochs' },
    ],
  },
  quote: {
    title: 'Quote',
    description: 'Quote a swap (best route, price impact) without building transactions',
    parameters: [
      token('from_token', 'From token', 'Token you pay with', true),
      token('to_token', 'To token', 'Token you receive', true),
      { name: 'amount', kind: 'string', label: 'Amount', required: true, placeholder: '0.1', description: 'Amount to swap (raw units, or human units with --use-decimals)' },
      useDecimals,
    ],
    examples: [{ command: 'aero quote --from-token ETH --to-token USDC --amount 0.1 --use-decimals', description: 'How much USDC 0.1 ETH buys right now' }],
  },
  swap: {
    title: 'Swap',
    description: 'Swap tokens through the best route (approvals, then the swap)',
    parameters: [
      token('from_token', 'From token', 'Token you pay with', true),
      token('to_token', 'To token', 'Token you receive', true),
      { name: 'amount', kind: 'string', label: 'Amount', required: true, placeholder: '0.1', description: 'Amount to swap (raw units, or human units with --use-decimals)' },
      slippage,
      useDecimals,
    ],
    examples: [
      { command: 'aero swap --from-token ETH --to-token USDC --amount 0.1 --use-decimals', description: 'Swap 0.1 ETH for USDC after a confirmation prompt' },
      { command: 'aero swap --from-token USDC --to-token AERO --amount 25 --use-decimals --dry-run', description: 'Print the unsigned plan without broadcasting' },
    ],
  },
  deposit: {
    title: 'Add liquidity',
    description: 'Add liquidity to a pool, or create one from a token pair',
    parameters: [
      { name: 'pool', kind: 'address', label: 'Pool', picker: 'pool', placeholder: '0x address', description: 'Existing pool; omit it to create a new pool from token0, token1, and pool type' },
      { ...token('token0', 'Token 0', 'First token of a new pool'), group: 'new-pool' },
      { ...token('token1', 'Token 1', 'Second token of a new pool'), group: 'new-pool' },
      { ...poolType, group: 'new-pool' },
      { name: 'amount0', kind: 'string', label: 'Amount 0', placeholder: '0.1', description: 'Amount of token0 (the other side is quoted for existing pools)' },
      { name: 'amount1', kind: 'string', label: 'Amount 1', placeholder: '250', description: 'Amount of token1' },
      { name: 'tick_spacing', kind: 'integer', label: 'Tick spacing', group: 'new-cl-pool', placeholder: '100', description: 'Tick spacing for a new CL pool' },
      { name: 'price_lower', kind: 'number', label: 'Price lower', group: 'cl', placeholder: '2200', description: 'CL range lower bound as a price' },
      { name: 'price_upper', kind: 'number', label: 'Price upper', group: 'cl', placeholder: '2800', description: 'CL range upper bound as a price' },
      { name: 'tick_lower', kind: 'integer', label: 'Tick lower', group: 'cl', description: 'CL range lower bound as a tick (instead of a price)' },
      { name: 'tick_upper', kind: 'integer', label: 'Tick upper', group: 'cl', description: 'CL range upper bound as a tick (instead of a price)' },
      { name: 'initial_price', kind: 'number', label: 'Initial price', group: 'cl', description: 'Starting price for an uninitialized CL pool' },
      slippage,
      deadline,
      useDecimals,
    ],
    examples: [{ command: 'aero deposit --pool 0x... --amount0 100 --use-decimals', description: 'Quote the matching amount1 and deposit into a basic pool' }],
  },
  withdraw: {
    title: 'Withdraw',
    description: 'Remove liquidity from a position (fully or a fraction)',
    parameters: [
      pool,
      position,
      { name: 'fraction', kind: 'decimal_string', label: 'Fraction', placeholder: '0.5', description: 'Fraction to withdraw (0.5 = half); empty withdraws everything' },
      burn,
      { name: 'collect', kind: 'boolean', label: 'Collect fees', default: true, description: 'Collect owed fees while withdrawing (CL only)' },
      unwrapNative,
      slippage,
      deadline,
    ],
  },
  stake: {
    title: 'Stake',
    description: 'Stake a position in its gauge to start earning emissions',
    parameters: [pool, position],
  },
  unstake: {
    title: 'Unstake',
    description: 'Unstake a position from its gauge',
    parameters: [
      pool,
      position,
      { name: 'amount', kind: 'string', label: 'Amount', placeholder: 'all', description: 'LP amount to unstake (basic pools); empty unstakes everything' },
    ],
  },
  claim_emissions: {
    title: 'Claim emissions',
    description: 'Claim gauge emissions earned by a staked position',
    parameters: [pool, position],
  },
  claim_fees: {
    title: 'Claim fees',
    description: 'Claim trading fees earned by an unstaked position',
    parameters: [pool, position, burn, unwrapNative],
  },
  create_venft: {
    title: 'Lock veNFT',
    description: 'Lock AERO/VELO into a veNFT for voting power',
    parameters: [
      { name: 'amount', kind: 'string', label: 'Amount', required: true, placeholder: '100', description: 'AERO/VELO to lock' },
      { name: 'lock_duration_seconds', kind: 'integer', label: 'Lock (seconds)', required: true, placeholder: '31536000', description: 'Lock duration in seconds, rounded down to whole weeks, max 4 years (1 year = 31536000)' },
      useDecimals,
    ],
    examples: [{ command: 'aero create-venft --amount 100 --use-decimals --lock-duration-seconds 31536000', description: 'Lock 100 AERO for one year' }],
  },
} satisfies Record<SugarAction, ActionSpec>

export function actionSpec(action: SugarAction): ActionSpec {
  return ACTION_SCHEMA[action]
}

/** Actions that read the connected wallet when `wallet` is omitted. */
export function acceptsWallet(action: SugarAction): boolean {
  return isSugarTxAction(action) || action === 'positions' || action === 'stocks'
}

export const CHAIN_PARAMETER: ParameterSpec = { name: 'chain', kind: 'integer', label: 'Chain', required: true, placeholder: '8453', description: 'Chain id (defaults to 8453, Base, home of Aerodrome)' }
export const WALLET_PARAMETER: ParameterSpec = { name: 'wallet', kind: 'address', label: 'Wallet', placeholder: '0x address', description: 'Wallet address (defaults to the connected wallet)' }

/**
 * Every parameter a request may carry: the context parameters first, then the
 * action's own. `wallet` is required for transactions; the CLI and TUI fill it
 * from the connected wallet before validation.
 */
export function requestParameters(action: SugarAction): ParameterSpec[] {
  const wallet = acceptsWallet(action) ? [{ ...WALLET_PARAMETER, required: isSugarTxAction(action) }] : []
  return [CHAIN_PARAMETER, ...wallet, ...ACTION_SCHEMA[action].parameters]
}
