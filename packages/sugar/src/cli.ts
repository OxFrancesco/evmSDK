#!/usr/bin/env bun
// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.

import * as Predicate from 'effect/Predicate'
import { executeSugarAction, type SugarExecutionOptions } from './actions'
import { isSugarAction, SUGAR_ACTIONS, type SugarAction, type SugarParameter, type SugarParameters } from './contracts'

/**
 * Programmatic CLI surface. The interactive `aero` binary lives in
 * src/cli/root.ts on effect/unstable/cli (typed subcommands, --wizard,
 * --completions); the helpers here remain for headless scripts and embedders
 * that feed argv-style requests straight into executeSugarAction.
 */

const BOOLEAN_FLAGS = new Set(['burn', 'collect', 'full', 'unwrap_native', 'use_decimals'])
const NUMBER_FLAGS = new Set([
  'chain', 'deadline_minutes', 'initial_price', 'limit', 'lock_duration_seconds', 'offset',
  'price_lower', 'price_upper', 'slippage', 'tick_lower', 'tick_spacing', 'tick_upper',
])

export const SUGAR_CLI_HELP = `Usage: sugar-ts <action> [--flag=value]

⚠️  Vibecoded & early beta — use at your own risk. Review every unsigned
plan before signing and never risk funds you cannot afford to lose.

Actions: ${SUGAR_ACTIONS.map((action) => action.replaceAll('_', '-')).join(', ')}

This headless entrypoint always prints JSON (transaction actions print an
unsigned plan). For the interactive wallet-connected experience use the
\`aero\` binary: subcommand help (aero <action> --help), guided input
(aero <action> --wizard), guides (aero guide), and shell completions
(aero --completions zsh|bash|fish).

Environment: SUGAR_RPC_URI_<chain> (RPC override).`

function parseBoolean(name: string, value: string): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`--${name.replaceAll('_', '-')} must be true or false`)
}

function coerceFlag(name: string, value: string): SugarParameter {
  if (BOOLEAN_FLAGS.has(name)) return parseBoolean(name, value)
  if (NUMBER_FLAGS.has(name)) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`--${name.replaceAll('_', '-')} must be a number`)
    return number
  }
  return value
}

export type ParsedSugarCliArgs = { action: SugarAction; parameters: SugarParameters }

export function parseSugarCliArgs(argv: string[]): ParsedSugarCliArgs {
  const [rawAction, ...flags] = argv
  if (!rawAction || rawAction === '--help' || rawAction === '-h') throw new Error(SUGAR_CLI_HELP)
  const action = rawAction.replaceAll('-', '_')
  if (!isSugarAction(action)) throw new Error(`Unknown Sugar action: ${rawAction}\n\n${SUGAR_CLI_HELP}`)
  const parameters: SugarParameters = {}
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (!flag.startsWith('--')) throw new Error(`Unexpected positional argument: ${flag}`)
    const equals = flag.indexOf('=')
    const rawName = flag.slice(2, equals === -1 ? undefined : equals)
    const negated = rawName.startsWith('no-')
    const name = (negated ? rawName.slice(3) : rawName).replaceAll('-', '_')
    let value = equals === -1 ? undefined : flag.slice(equals + 1)
    if (negated) {
      if (!BOOLEAN_FLAGS.has(name) || value !== undefined) throw new Error(`Invalid negated flag: ${flag}`)
      parameters[name] = false
      continue
    }
    if (value === undefined && BOOLEAN_FLAGS.has(name)) {
      const following = flags[index + 1]
      if (following === 'true' || following === 'false') value = flags[++index]
      else value = 'true'
    } else if (value === undefined) {
      value = flags[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`)
    }
    parameters[name] = coerceFlag(name, value)
  }
  return { action, parameters }
}

export async function runSugarCli(
  argv = Bun.argv.slice(2),
  options: SugarExecutionOptions = {},
  write: (output: string) => void = console.log,
): Promise<string> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    write(SUGAR_CLI_HELP)
    return SUGAR_CLI_HELP
  }
  const { action, parameters } = parseSugarCliArgs(argv)
  const output = JSON.stringify(await executeSugarAction(action, parameters, options), null, 2)
  write(output)
  return output
}

export type SendFlagSplit = { argv: string[]; yes: boolean; dryRun: boolean }

/** Split wallet-flow flags (--yes, --dry-run) from the Sugar action flags. */
export function splitSendFlags(argv: string[]): SendFlagSplit {
  const rest: string[] = []
  let yes = false
  let dryRun = false
  for (const flag of argv) {
    if (flag === '--yes' || flag === '-y') yes = true
    else if (flag === '--dry-run') dryRun = true
    else rest.push(flag)
  }
  return { argv: rest, yes, dryRun }
}

/** WalletConnect rejects with plain objects ({ message, code }), not Errors. */
export function formatCliError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (Predicate.isObject(cause)) {
    const message = 'message' in cause ? cause.message : undefined
    const code = 'code' in cause ? cause.code : undefined
    if (Predicate.isString(message)) return code === undefined ? message : `${message} (code ${code})`
    return JSON.stringify(cause)
  }
  return String(cause)
}

if (import.meta.main) {
  const { runAeroCliMain } = await import('./cli/root')
  runAeroCliMain()
}
