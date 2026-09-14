import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Console from 'effect/Console'
import * as flags from './flags'
import { definedParameters, optionalValue } from './flags'
import { actionCommand } from './action-commands'
import { runTxAction } from './run-action'
import { deleteIndex, listIndices, readIndex, saveIndex, type StockIndex } from '../stocks/indices'

const name = Flag.string('name').pipe(Flag.withMetavar('<name>'), Flag.withDescription('Saved index name'))
const allocations = Flag.string('allocations').pipe(
  Flag.withMetavar('<SYMBOL=percent,...>'),
  Flag.withDescription('Target percentages, e.g. NVDAc=50,AAPLc=50. Use 0 to exit a stock.'),
)
const printJson = (value: StockIndex | StockIndex[]) => Console.log(JSON.stringify(value, null, 2))

export const stocksCommand = Command.make('stocks').pipe(
  Command.withDescription('Trade tokenized stocks on Base with USDC'),
  Command.withSubcommands([
    actionCommand('stocks', 'list'),
    actionCommand('stock_buy', 'buy'),
    actionCommand('stock_sell', 'sell'),
  ]),
)

export const indexCommand = Command.make('index').pipe(
  Command.withDescription('Save target weights and rebalance wallet holdings toward them'),
  Command.withSubcommands([
    Command.make('create', { name, allocations }, Effect.fn(function* (config) {
      yield* printJson(saveIndex(config.name, config.allocations))
    })).pipe(Command.withDescription('Save a new index with target weights')),
    Command.make('update', { name, allocations }, Effect.fn(function* (config) {
      yield* printJson(saveIndex(config.name, config.allocations, true))
    })).pipe(Command.withDescription('Replace the weights of a saved index')),
    Command.make('list', {}, Effect.fn(function* () {
      yield* printJson(listIndices())
    })).pipe(Command.withDescription('List saved indices')),
    Command.make('show', { name }, Effect.fn(function* (config) {
      yield* printJson(readIndex(config.name))
    })).pipe(Command.withDescription('Show one saved index')),
    Command.make('delete', { name }, Effect.fn(function* (config) {
      deleteIndex(config.name)
      yield* Console.log(`Deleted ${config.name}. Wallet holdings unchanged.`)
    })).pipe(Command.withDescription('Delete saved weights (wallet holdings stay untouched)')),
    Command.make('rebalance', {
      chain: flags.chain,
      wallet: flags.wallet,
      name,
      cash: Flag.string('cash').pipe(Flag.withDefault('0'), Flag.withMetavar('<USDC>'), Flag.withDescription('USDC added on top of existing holdings (default 0)')),
      slippage: Flag.float('slippage').pipe(Flag.optional, Flag.withDescription('Slippage tolerance between 0 and 1 (0.01 = 1%)')),
      yes: flags.yes,
      dryRun: flags.dryRun,
    }, Effect.fn(function* (config) {
      yield* runTxAction('index_rebalance', definedParameters({
        chain: config.chain,
        wallet: optionalValue(config.wallet),
        allocations: readIndex(config.name).allocations,
        cash: config.cash,
        slippage: optionalValue(config.slippage),
      }), { yes: config.yes, dryRun: config.dryRun })
    })).pipe(
      Command.withDescription('Trade wallet holdings toward a saved index'),
      Command.withExamples([{ command: 'aero index rebalance --name tech --cash 100 --dry-run', description: 'Preview the trades that move holdings plus 100 USDC to the tech weights' }]),
    ),
  ]),
)
