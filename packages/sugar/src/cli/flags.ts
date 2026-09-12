import * as Option from 'effect/Option'
import * as Flag from 'effect/unstable/cli/Flag'
import type { SugarParameter, SugarParameters } from '../contracts'

/** Default chain for every command: Base, home of Aerodrome. */
export const DEFAULT_CHAIN = 8453

export const chain = Flag.integer('chain').pipe(
  Flag.withDefault(DEFAULT_CHAIN),
  Flag.withDescription('Chain id (defaults to 8453 — Base, home of Aerodrome)'),
)

export const wallet = Flag.string('wallet').pipe(
  Flag.optional,
  Flag.withMetavar('<0x address>'),
  Flag.withDescription('Wallet address (defaults to the connected wallet)'),
)

export const pool = Flag.string('pool').pipe(
  Flag.optional,
  Flag.withMetavar('<0x address>'),
  Flag.withDescription('Pool (liquidity pair) address'),
)

export const position = Flag.string('position').pipe(
  Flag.optional,
  Flag.withMetavar('<id>'),
  Flag.withDescription('Position id (list yours with: aero positions)'),
)

export const poolType = Flag.choice('pool-type', ['cl', 'stable', 'volatile']).pipe(
  Flag.optional,
  Flag.withDescription('Filter or select the pool flavor'),
)

export const fromToken = Flag.string('from-token').pipe(
  Flag.optional,
  Flag.withMetavar('<symbol|0x address>'),
  Flag.withDescription('Token you pay with (symbol like ETH/USDC, or address; omitted interactively opens a fuzzy token finder)'),
)

export const toToken = Flag.string('to-token').pipe(
  Flag.optional,
  Flag.withMetavar('<symbol|0x address>'),
  Flag.withDescription('Token you receive (symbol like ETH/USDC, or address; omitted interactively opens a fuzzy token finder)'),
)

export const amount = Flag.string('amount').pipe(
  Flag.withMetavar('<amount>'),
  Flag.withDescription('Amount to use (raw units, or decimals with --use-decimals)'),
)

export const useDecimals = Flag.boolean('use-decimals').pipe(
  Flag.withDescription('Read amounts as human units (0.1 ETH) instead of raw wei'),
)

export const slippage = Flag.float('slippage').pipe(
  Flag.optional,
  Flag.withDescription('Slippage tolerance between 0 and 1 (0.01 = 1%)'),
)

export const deadlineMinutes = Flag.integer('deadline-minutes').pipe(
  Flag.optional,
  Flag.withDescription('Transaction deadline in minutes (default 30)'),
)

export const yes = Flag.boolean('yes').pipe(
  Flag.withAlias('y'),
  Flag.withDescription('Skip the sign-and-broadcast confirmation prompt'),
)

export const dryRun = Flag.boolean('dry-run').pipe(
  Flag.withDescription('Always print the unsigned plan, never broadcast'),
)

export const token0 = Flag.string('token0').pipe(
  Flag.optional,
  Flag.withMetavar('<symbol|0x address>'),
  Flag.withDescription('First pool token (symbol or address)'),
)

export const token1 = Flag.string('token1').pipe(
  Flag.optional,
  Flag.withMetavar('<symbol|0x address>'),
  Flag.withDescription('Second pool token (symbol or address)'),
)

export const burn = Flag.boolean('burn').pipe(
  Flag.withDescription('Burn the emptied CL position NFT'),
)

export const unwrapNative = Flag.boolean('unwrap-native').pipe(
  Flag.withDescription('Unwrap the wrapped native leg back to the native token'),
)

/** `collect` defaults to true server-side, so only an explicit opt-out is sent. */
export const noCollect = Flag.boolean('no-collect').pipe(
  Flag.withDescription('Skip collecting owed fees while withdrawing (CL only)'),
)

/** Drop unset flags so the shared validator sees exactly what the user passed. */
export function definedParameters(entries: Record<string, SugarParameter | undefined>): SugarParameters {
  const output: SugarParameters = {}
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined) output[name] = value
  }
  return output
}

export function optionalValue<A>(option: Option.Option<A>): A | undefined {
  return Option.getOrUndefined(option)
}
