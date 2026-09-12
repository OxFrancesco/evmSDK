import * as Flag from 'effect/unstable/cli/Flag'
import * as Command from 'effect/unstable/cli/Command'
import * as Effect from 'effect/Effect'
import * as flags from './flags'
import { definedParameters, optionalValue } from './flags'
import { runReadAction, runTxAction } from './run-action'

const positions = Command.make('positions', {
  chain: flags.chain,
  wallet: flags.wallet,
  owner: Flag.string('owner').pipe(
    Flag.optional,
    Flag.withMetavar('<0x address>'),
    Flag.withDescription('List positions for another address'),
  ),
}, Effect.fn(function* (config) {
  yield* runReadAction('positions', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    owner: optionalValue(config.owner),
  }))
})).pipe(
  Command.withDescription('List your liquidity positions (basic and concentrated)'),
  Command.withExamples([
    { command: 'aero positions', description: 'Positions for the connected wallet on Base' },
  ]),
)

const pools = Command.make('pools', {
  chain: flags.chain,
  token0: flags.token0,
  token1: flags.token1,
  poolType: flags.poolType,
  full: Flag.boolean('full').pipe(Flag.withDescription('Hydrate pools with tokens, reserves, TVL, and emissions')),
  limit: Flag.integer('limit').pipe(Flag.optional, Flag.withDescription('Return at most this many pools (1-100)')),
}, Effect.fn(function* (config) {
  yield* runReadAction('pools', definedParameters({
    chain: config.chain,
    token0: optionalValue(config.token0),
    token1: optionalValue(config.token1),
    pool_type: optionalValue(config.poolType),
    full: config.full,
    limit: optionalValue(config.limit),
  }))
})).pipe(
  Command.withDescription('Browse liquidity pools, optionally filtered by tokens'),
  Command.withExamples([
    { command: 'aero pools --token0 ETH --token1 USDC --full --limit 5', description: 'Top ETH/USDC pools with reserves and TVL' },
  ]),
)

const epochsLatest = Command.make('epochs-latest', {
  chain: flags.chain,
  poolType: flags.poolType,
}, Effect.fn(function* (config) {
  yield* runReadAction('epochs_latest', definedParameters({
    chain: config.chain,
    pool_type: optionalValue(config.poolType),
  }))
})).pipe(Command.withDescription('Latest voting epoch (votes, emissions, fees, incentives) per pool'))

const epochs = Command.make('epochs', {
  chain: flags.chain,
  lp: Flag.string('lp').pipe(Flag.withMetavar('<0x address>'), Flag.withDescription('Pool address to inspect')),
  poolType: flags.poolType,
  limit: Flag.integer('limit').pipe(Flag.optional, Flag.withDescription('Epochs to return (default 10)')),
  offset: Flag.integer('offset').pipe(Flag.optional, Flag.withDescription('Skip this many epochs')),
}, Effect.fn(function* (config) {
  yield* runReadAction('epochs', definedParameters({
    chain: config.chain,
    lp: config.lp,
    pool_type: optionalValue(config.poolType),
    limit: optionalValue(config.limit),
    offset: optionalValue(config.offset),
  }))
})).pipe(Command.withDescription('Voting epoch history for one pool'))

const quote = Command.make('quote', {
  chain: flags.chain,
  fromToken: flags.fromToken,
  toToken: flags.toToken,
  amount: flags.amount,
  useDecimals: flags.useDecimals,
}, Effect.fn(function* (config) {
  yield* runReadAction('quote', definedParameters({
    chain: config.chain,
    from_token: optionalValue(config.fromToken),
    to_token: optionalValue(config.toToken),
    amount: config.amount,
    use_decimals: config.useDecimals,
  }))
})).pipe(
  Command.withDescription('Quote a swap (best route, price impact) without building transactions'),
  Command.withExamples([
    { command: 'aero quote --from-token ETH --to-token USDC --amount 0.1 --use-decimals', description: 'How much USDC 0.1 ETH buys right now' },
  ]),
)

const swap = Command.make('swap', {
  chain: flags.chain,
  wallet: flags.wallet,
  fromToken: flags.fromToken,
  toToken: flags.toToken,
  amount: flags.amount,
  slippage: flags.slippage,
  useDecimals: flags.useDecimals,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('swap', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    from_token: optionalValue(config.fromToken),
    to_token: optionalValue(config.toToken),
    amount: config.amount,
    slippage: optionalValue(config.slippage),
    use_decimals: config.useDecimals,
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(
  Command.withDescription('Swap tokens through the best route (quotes, approvals, then the swap)'),
  Command.withExamples([
    { command: 'aero swap --from-token ETH --to-token USDC --amount 0.1 --use-decimals', description: 'Swap 0.1 ETH for USDC after a confirmation prompt' },
    { command: 'aero swap --from-token USDC --to-token AERO --amount 25 --use-decimals --dry-run', description: 'Print the unsigned plan without broadcasting' },
  ]),
)

const deposit = Command.make('deposit', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  token0: flags.token0,
  token1: flags.token1,
  poolType: flags.poolType,
  tickSpacing: Flag.integer('tick-spacing').pipe(Flag.optional, Flag.withDescription('CL pool tick spacing (required for new CL pools)')),
  amount0: Flag.string('amount0').pipe(Flag.optional, Flag.withMetavar('<amount>'), Flag.withDescription('Amount of token0 to deposit')),
  amount1: Flag.string('amount1').pipe(Flag.optional, Flag.withMetavar('<amount>'), Flag.withDescription('Amount of token1 to deposit')),
  priceLower: Flag.float('price-lower').pipe(Flag.optional, Flag.withDescription('CL range lower bound as a price')),
  priceUpper: Flag.float('price-upper').pipe(Flag.optional, Flag.withDescription('CL range upper bound as a price')),
  tickLower: Flag.integer('tick-lower').pipe(Flag.optional, Flag.withDescription('CL range lower bound as a tick')),
  tickUpper: Flag.integer('tick-upper').pipe(Flag.optional, Flag.withDescription('CL range upper bound as a tick')),
  initialPrice: Flag.float('initial-price').pipe(Flag.optional, Flag.withDescription('Starting price for an uninitialized CL pool')),
  slippage: flags.slippage,
  deadlineMinutes: flags.deadlineMinutes,
  useDecimals: flags.useDecimals,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('deposit', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    token0: optionalValue(config.token0),
    token1: optionalValue(config.token1),
    pool_type: optionalValue(config.poolType),
    tick_spacing: optionalValue(config.tickSpacing),
    amount0: optionalValue(config.amount0),
    amount1: optionalValue(config.amount1),
    price_lower: optionalValue(config.priceLower),
    price_upper: optionalValue(config.priceUpper),
    tick_lower: optionalValue(config.tickLower),
    tick_upper: optionalValue(config.tickUpper),
    initial_price: optionalValue(config.initialPrice),
    slippage: optionalValue(config.slippage),
    deadline_minutes: optionalValue(config.deadlineMinutes),
    use_decimals: config.useDecimals,
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(
  Command.withDescription('Add liquidity to a pool (pass --pool, or --token0/--token1/--pool-type)'),
  Command.withExamples([
    { command: 'aero deposit --pool 0x... --amount0 100 --use-decimals', description: 'Quote the matching amount1 and deposit into a basic pool' },
  ]),
)

const withdraw = Command.make('withdraw', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  position: flags.position,
  fraction: Flag.string('fraction').pipe(Flag.optional, Flag.withMetavar('<0-1>'), Flag.withDescription('Withdraw only this fraction of the position (e.g. 0.5)')),
  burn: flags.burn,
  noCollect: flags.noCollect,
  unwrapNative: flags.unwrapNative,
  slippage: flags.slippage,
  deadlineMinutes: flags.deadlineMinutes,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('withdraw', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    position: optionalValue(config.position),
    fraction: optionalValue(config.fraction),
    burn: config.burn,
    collect: config.noCollect ? false : undefined,
    unwrap_native: config.unwrapNative,
    slippage: optionalValue(config.slippage),
    deadline_minutes: optionalValue(config.deadlineMinutes),
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(Command.withDescription('Remove liquidity from a position (fully or a fraction)'))

const stake = Command.make('stake', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  position: flags.position,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('stake', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    position: optionalValue(config.position),
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(Command.withDescription('Stake a position in its gauge to start earning emissions'))

const unstake = Command.make('unstake', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  position: flags.position,
  amount: Flag.string('amount').pipe(Flag.optional, Flag.withMetavar('<amount>'), Flag.withDescription('LP amount to unstake (basic pools; defaults to everything)')),
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('unstake', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    position: optionalValue(config.position),
    amount: optionalValue(config.amount),
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(Command.withDescription('Unstake a position from its gauge'))

const claimEmissions = Command.make('claim-emissions', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  position: flags.position,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('claim_emissions', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    position: optionalValue(config.position),
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(Command.withDescription('Claim gauge emissions earned by a staked position'))

const claimFees = Command.make('claim-fees', {
  chain: flags.chain,
  wallet: flags.wallet,
  pool: flags.pool,
  position: flags.position,
  burn: flags.burn,
  unwrapNative: flags.unwrapNative,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('claim_fees', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    pool: optionalValue(config.pool),
    position: optionalValue(config.position),
    burn: config.burn,
    unwrap_native: config.unwrapNative,
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(Command.withDescription('Claim trading fees earned by an unstaked position'))

const createVenft = Command.make('create-venft', {
  chain: flags.chain,
  wallet: flags.wallet,
  amount: flags.amount,
  lockDurationSeconds: Flag.integer('lock-duration-seconds').pipe(
    Flag.withDescription('Lock duration in seconds (rounded down to whole weeks, max 4 years)'),
  ),
  useDecimals: flags.useDecimals,
  yes: flags.yes,
  dryRun: flags.dryRun,
}, Effect.fn(function* (config) {
  yield* runTxAction('create_venft', definedParameters({
    chain: config.chain,
    wallet: optionalValue(config.wallet),
    amount: config.amount,
    lock_duration_seconds: config.lockDurationSeconds,
    use_decimals: config.useDecimals,
  }), { yes: config.yes, dryRun: config.dryRun })
})).pipe(
  Command.withDescription('Lock AERO/VELO into a veNFT for voting power'),
  Command.withExamples([
    { command: 'aero create-venft --amount 100 --use-decimals --lock-duration-seconds 31536000', description: 'Lock 100 AERO for one year' },
  ]),
)

export const actionCommands = [
  quote,
  swap,
  pools,
  deposit,
  withdraw,
  positions,
  stake,
  unstake,
  claimEmissions,
  claimFees,
  createVenft,
  epochsLatest,
  epochs,
]
