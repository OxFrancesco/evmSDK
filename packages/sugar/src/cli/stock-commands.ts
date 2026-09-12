import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Console from 'effect/Console'
import * as flags from './flags'
import { definedParameters, optionalValue } from './flags'
import { runReadAction, runTxAction } from './run-action'
import { deleteIndex, listIndices, readIndex, saveIndex } from '../stocks/indices'

const name = Flag.string('name').pipe(Flag.withDescription('Saved index name'))
const allocations = Flag.string('allocations').pipe(Flag.withDescription('Target percentages, e.g. NVDAc=50,AAPLc=50. Use 0% to exit a stock.'))
const trading = { chain: flags.chain, wallet: flags.wallet, slippage: flags.slippage, yes: flags.yes, dryRun: flags.dryRun }
const tradeCommands = (['buy', 'sell'] as const).map((side) => Command.make(side, {
  ...trading,
  stock: Flag.string('stock'),
  amount: Flag.string('amount').pipe(Flag.withDescription(side === 'buy' ? 'USDC to spend' : 'Stock token units to sell')),
}, Effect.fn(function* (config) {
  yield* runTxAction(side === 'buy' ? 'stock_buy' : 'stock_sell', definedParameters({
    chain: config.chain, wallet: optionalValue(config.wallet), stock: config.stock,
    amount: config.amount, slippage: optionalValue(config.slippage),
  }), { yes: config.yes, dryRun: config.dryRun })
})))

export const stocksCommand = Command.make('stocks').pipe(Command.withDescription('Trade tokenized stocks on Base with USDC'), Command.withSubcommands([
  Command.make('list', { chain: flags.chain, wallet: flags.wallet }, Effect.fn(function* (config) {
    yield* runReadAction('stocks', definedParameters({ chain: config.chain, wallet: optionalValue(config.wallet) }))
  })),
  ...tradeCommands,
]))

export const indexCommand = Command.make('index').pipe(Command.withDescription('Save target weights and rebalance wallet holdings'), Command.withSubcommands([
  Command.make('create', { name, allocations }, Effect.fn(function* (config) {
    yield* Console.log(JSON.stringify(saveIndex(config.name, config.allocations), null, 2))
  })),
  Command.make('update', { name, allocations }, Effect.fn(function* (config) {
    yield* Console.log(JSON.stringify(saveIndex(config.name, config.allocations, true), null, 2))
  })),
  Command.make('list', {}, Effect.fn(function* () { yield* Console.log(JSON.stringify(listIndices(), null, 2)) })),
  Command.make('show', { name }, Effect.fn(function* (config) { yield* Console.log(JSON.stringify(readIndex(config.name), null, 2)) })),
  Command.make('delete', { name }, Effect.fn(function* (config) { deleteIndex(config.name); yield* Console.log(`Deleted ${config.name}. Wallet holdings unchanged.`) })),
  Command.make('rebalance', { ...trading, name, cash: Flag.string('cash').pipe(Flag.withDefault('0'), Flag.withDescription('USDC contribution, default 0. Existing holdings of index stocks are included.')) }, Effect.fn(function* (config) {
    yield* runTxAction('index_rebalance', definedParameters({
      chain: config.chain, wallet: optionalValue(config.wallet), allocations: readIndex(config.name).allocations,
      cash: config.cash, slippage: optionalValue(config.slippage),
    }), { yes: config.yes, dryRun: config.dryRun })
  })),
]))
