import { stocksCommand, indexCommand } from './stock-commands'
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import { isCliError } from 'effect/unstable/cli/CliError'
import { formatCliError } from '../cli'
import { actionCommands } from './action-commands'
import { almCommand, serveCommand } from './alm-commands'
import { guideCommand } from './guide'
import { fromPromise } from './run-action'
import { walletCommand } from './wallet-commands'
import { executionCommand } from './execution-commands'
import { stopWalletConnect } from '../walletconnect'

const tuiCommand = Command.make('tui', {}, Effect.fn(function* () {
  const { runAeroTui } = yield* Effect.promise(() => import('../tui/run'))
  yield* fromPromise(() => runAeroTui())
})).pipe(
  Command.withDescription('Full-screen terminal UI: Dune-style analytics, browse pools, positions, and epochs, run every action with guided forms, and sign from the connected wallet'),
)

const CLI_VERSION = '0.1.0'

export const rootCommand = Command.make('aero').pipe(
  Command.withDescription([
    'Aerodrome/Velodrome from your terminal: quotes, swaps, liquidity,',
    'staking, rewards, and veNFTs across the Superchain.',
    '',
    '⚠️  Vibecoded & early beta — use at your own risk. Review plans with',
    '--dry-run before signing and never risk funds you cannot afford to lose.',
    '',
    'Reads print JSON. Transaction commands print an unsigned plan unless a',
    'wallet is connected, in which case they show a summary, ask to confirm,',
    'then sign and broadcast (WalletConnect wallets approve in-app).',
    '',
    "New here? Run 'aero guide getting-started' or open the full-screen",
    "terminal UI with 'aero tui'. Any command can be filled in interactively",
    "with '--wizard', and '--completions <shell>' prints shell completion",
    'scripts.',
  ].join('\n')),
  Command.withSubcommands([tuiCommand, stocksCommand, indexCommand, ...actionCommands, serveCommand, almCommand, walletCommand, executionCommand, guideCommand]),
)

/**
 * Bin entrypoint. Parse errors and help output are rendered by the CLI
 * runtime; every other failure is reduced to one readable line (WalletConnect
 * rejects with plain objects, not Errors). The explicit exit prevents the
 * WalletConnect relay socket from keeping the process alive.
 */
export function runAeroCliMain(): void {
  const program = Command.run(rootCommand, { version: CLI_VERSION }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.sync(() => {
        const failure = Cause.squash(cause)
        // Parse/usage errors were already rendered by Command.run.
        if (!isCliError(failure)) console.error(formatCliError(failure))
        process.exitCode = 1
      }),
    ),
    Effect.ensuring(Effect.promise(stopWalletConnect)),
    Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  )
  BunRuntime.runMain(program, { disableErrorReporting: true })
}
