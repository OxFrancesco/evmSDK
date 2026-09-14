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
import { stopBrowserWallet } from '../browser-wallet'

const tuiCommand = Command.make('tui', {}, Effect.fn(function* () {
  const { runAeroTui } = yield* Effect.promise(() => import('../tui/run'))
  yield* fromPromise(() => runAeroTui())
})).pipe(
  Command.withDescription('Full-screen terminal UI: browse, analytics, guided forms, and signing'),
)

const CLI_VERSION = '0.1.0'

// The help formatter indents only the first description line, so keep it to
// one sentence; the tour lives in `aero guide getting-started`.
export const rootCommand = Command.make('aero').pipe(
  Command.withDescription('Aerodrome/Velodrome from your terminal (early beta). Reads print JSON; transactions show a plan and ask before signing. Start with: aero guide getting-started, or aero tui.'),
  Command.withSubcommands([tuiCommand, ...actionCommands, stocksCommand, indexCommand, walletCommand, serveCommand, almCommand, executionCommand, guideCommand]),
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
    Effect.ensuring(Effect.sync(stopBrowserWallet)),
    Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  )
  BunRuntime.runMain(program, { disableErrorReporting: true })
}
