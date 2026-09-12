import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { FileSystem, Layer, Path, Terminal } from 'effect'
import * as Queue from 'effect/Queue'
import { resolveTokenParameters } from './tokens'
import type { Token } from '../types'

/**
 * The resolver's type includes the prompt environment (the interactive path
 * needs Terminal), but headless tests never execute a prompt. Provide inert
 * services so runPromise sees `never` requirements without touching stdio.
 */
const inertEnv = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Layer.succeed(Terminal.Terminal, Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.map(Queue.make<Terminal.UserInput>(), (queue) => queue),
    readLine: Effect.die('not used in these tests'),
    display: () => Effect.void,
  })),
)

function makeToken(symbol: string, address: string): Token {
  return {
    chainId: 8453,
    chainName: 'Base',
    tokenAddress: address,
    symbol,
    decimals: 18,
    listed: true,
    emerging: false,
  }
}

const TOKENS = [
  makeToken('ETH', 'ETH'),
  makeToken('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
]

const run = (action: string, parameters: Parameters<typeof resolveTokenParameters>[1]) =>
  Effect.runPromise(Effect.provide(resolveTokenParameters(action, parameters, { interactive: false, tokens: TOKENS }), inertEnv))

describe('CLI token parameter resolution', () => {
  test('resolved tokens retain their identity instead of being looked up by symbol again', async () => {
    const resolved = await run('swap', { chain: 8453, from_token: 'eth', to_token: 'USDC', amount: '1' })
    expect(resolved.from_token).toBe('ETH')
    expect(resolved.to_token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  test('addresses pass through even when unknown to the catalog', async () => {
    const mystery = '0x0000000000000000000000000000000000000042'
    const resolved = await run('swap', { chain: 8453, from_token: mystery, to_token: 'USDC', amount: '1' })
    expect(resolved.from_token).toBe(mystery)
  })

  test('actions without token parameters skip resolution entirely', async () => {
    const resolved = await run('positions', { chain: 8453 })
    expect(resolved).toEqual({ chain: 8453 })
  })

  test('ambiguous symbols fail headless runs with the closest candidates', async () => {
    let message = ''
    try {
      await run('swap', { chain: 8453, from_token: 'usdcx', to_token: 'USDC', amount: '1' })
    } catch (cause) {
      // SAFETY: runPromise rethrows the resolver's Error defects verbatim.
      message = String((cause as Error).message ?? cause)
    }
    expect(message).toContain('--from-token "usdcx" does not match a listed Aerodrome token')
    expect(message).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  test('missing required tokens stay missing so the action layer reports them', async () => {
    const resolved = await run('swap', { chain: 8453, amount: '1' })
    expect(resolved.from_token).toBeUndefined()
    expect(resolved.to_token).toBeUndefined()
  })

  test('unmatched optional filters still fail loudly instead of dropping silently', async () => {
    let message = ''
    try {
      await run('pools', { chain: 8453, token0: 'weth' })
    } catch (cause) {
      // SAFETY: runPromise rethrows the resolver's Error defects verbatim.
      message = String((cause as Error).message ?? cause)
    }
    expect(message).toContain('--token0 "weth" does not match')
  })
})
