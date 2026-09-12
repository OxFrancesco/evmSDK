import { expect, spyOn, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as wallet from '../wallet'
import { SugarClient } from '../client'
import { runReadAction } from './run-action'
import type { Token } from '../types'

test('public pool reads do not open the wallet or keychain', async () => {
  const active = spyOn(wallet, 'getActiveWallet').mockImplementation(() => {
    throw new Error('keychain unavailable')
  })
  const pools = spyOn(SugarClient.prototype, 'getPoolsForSwaps').mockResolvedValue([])
  try {
    await Effect.runPromise(runReadAction('pools', { chain: 8453 }).pipe(Effect.provide(BunServices.layer)))
    expect(active).not.toHaveBeenCalled()
  } finally {
    active.mockRestore()
    pools.mockRestore()
  }
})

test('token resolution and action execution use the same client', async () => {
  const clients = new Set<SugarClient>()
  const tokens: Token[] = [{
    chainId: 8453, chainName: 'Base', tokenAddress: 'ETH', symbol: 'ETH',
    wrappedTokenAddress: '0x4200000000000000000000000000000000000006',
    decimals: 18, listed: true, emerging: false,
  }]
  const catalog = spyOn(SugarClient.prototype, 'getAllTokens').mockImplementation(function (this: SugarClient) {
    clients.add(this)
    return Promise.resolve(tokens)
  })
  const pools = spyOn(SugarClient.prototype, 'getPoolsForSwaps').mockResolvedValue([])
  try {
    await Effect.runPromise(runReadAction('pools', { chain: 8453, token0: 'ETH' }).pipe(Effect.provide(BunServices.layer)))
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(clients.size).toBe(1)
  } finally {
    catalog.mockRestore()
    pools.mockRestore()
  }
})
