import * as Effect from 'effect/Effect'
import { dedupeTokens, loadTokenCatalog, resolveTokenReference, searchTokens, toTokenChoice, type TokenChoice } from '../token-catalog'
import type { SugarClient } from '../client'
import type { SugarParameters } from '../contracts'
import type { Token } from '../types'
import { DEFAULT_CHAIN } from './flags'
import { tokenPickPrompt } from './token-prompt'

/**
 * Token parameter resolution for the CLI. Every flag that names a token
 * (--from-token, --to-token, --token0, --token1) goes through here before
 * the action executes:
 *
 * - explicit 0x addresses pass through untouched (a deliberate escape hatch
 *   for unlisted tokens),
 * - exact symbol matches resolve as before,
 * - fuzzy or ambiguous input opens an interactive picker over the whitelisted
 *   on-chain catalog when a TTY is attached,
 * - headless runs fail with the closest candidates instead of a bare
 *   "token not found",
 * - missing required tokens prompt instead of erroring.
 */

const TOKEN_PARAMS = ['from_token', 'to_token', 'token0', 'token1'] as const

/** Actions whose token flags are mandatory; missing ones prompt instead of erroring. */
const REQUIRED_TOKEN_PARAMS = new Map<string, readonly string[]>([
  ['swap', ['from_token', 'to_token']],
  ['quote', ['from_token', 'to_token']],
])

/** Prompt output only helps humans; pipes and scripts keep hard errors. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export class TokenCanceledError extends Error {
  readonly _tag = 'TokenCanceledError'
  constructor() {
    super('Token selection canceled')
  }
}

function labelFor(name: string): string {
  if (name === 'from_token') return 'From token'
  if (name === 'to_token') return 'To token'
  return `Token ${name.slice(-1)}`
}

function suggestionLine(flag: string, reference: string, candidates: Token[]): string {
  const listed = candidates.slice(0, 5).map((token) => `${token.symbol} (${token.tokenAddress})`).join(', ')
  return `--${flag.replaceAll('_', '-')} "${reference}" does not match a listed Aerodrome token. Closest: ${listed}. Pass an exact symbol or a 0x address.`
}

export const resolveTokenParameters = Effect.fn('AeroCli.resolveTokenParameters')(function* (
  action: string,
  parameters: SugarParameters,
  injected: { interactive?: boolean; tokens?: Token[]; client?: SugarClient } = {},
) {
  const required = REQUIRED_TOKEN_PARAMS.get(action) ?? []
  const names = [...TOKEN_PARAMS].filter((name) =>
    parameters[name] !== undefined || required.includes(name))
  if (names.length === 0) return parameters
  const chainId = Number(parameters.chain ?? DEFAULT_CHAIN)
  const resolved: SugarParameters = { ...parameters }
  let choices: TokenChoice[] | undefined
  let catalog = injected.tokens
  const client = injected.client
  for (const name of names) {
    const raw = resolved[name] === undefined ? '' : String(resolved[name])
    // Addresses are intentional; unknown ones keep failing downstream.
    if (raw.startsWith('0x')) continue
    catalog ??= client
      ? dedupeTokens(yield* Effect.tryPromise(() => client.getAllTokens(true)))
      : yield* loadTokenCatalog(chainId)
    const tokens = catalog
    const { exact } = resolveTokenReference(tokens, raw)
    if (exact !== undefined) {
      resolved[name] = exact.tokenAddress
      continue
    }
    if (!(injected.interactive ?? interactive())) {
      // Keep the action layer's own "<flag> is required" error for headless runs.
      if (raw === '') continue
      throw new Error(suggestionLine(name, raw, searchTokens(tokens, raw)))
    }
    choices ??= tokens.map(toTokenChoice)
    const pick = yield* tokenPickPrompt({ message: labelFor(name), choices, initialQuery: raw })
    if (pick.canceled) throw new TokenCanceledError()
    // Store the address so a picked duplicate symbol stays unambiguous.
    resolved[name] = pick.choice.token.tokenAddress
  }
  return resolved
})
