import { describe, expect, test } from 'bun:test'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import { ACTION_SCHEMA } from '../action-schema'
import type { SugarParameters } from '../contracts'
import { validateSugarRequest } from '../index'
import { actionCommand } from './action-commands'
import { parametersFrom } from './flags'

for (const action of ['quote', 'swap'] as const) {
  describe(`${action} command parsing`, () => {
    async function parse(argv: string[]) {
      let parameters: SugarParameters | undefined
      const command = actionCommand(action).pipe(Command.withHandler((config) => Effect.sync(() => {
        parameters = parametersFrom(ACTION_SCHEMA[action].parameters, config)
      })))
      await Effect.runPromise(Command.runWith(command, { version: '0.1.0', renderErrors: false })(argv).pipe(
        Effect.provide(BunServices.layer),
      ))
      return parameters
    }

    test('missing tokens reach the handler for interactive selection', async () => {
      const parameters = await parse(['--amount', '0.1', '--use-decimals'])
      expect(parameters).toEqual({ amount: '0.1', use_decimals: true })
      const request: SugarParameters = { chain: 8453, ...parameters }
      if (action === 'swap') request.wallet = '0x1111111111111111111111111111111111111111'
      expect(() => validateSugarRequest(action, request)).toThrow('requires from_token')
    })

    test('explicit token references survive parsing', async () => {
      expect(await parse(['--amount', '1', '--from-token', 'ETH', '--to-token', 'USDC'])).toEqual({
        amount: '1', from_token: 'ETH', to_token: 'USDC',
      })
    })

    test('amount remains required before the handler', async () => {
      await expect(parse(['--from-token', 'ETH', '--to-token', 'USDC'])).rejects.toThrow()
    })
  })
}
