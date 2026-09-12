// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import * as Effect from 'effect/Effect'
import type { Address } from 'viem'
import { abis } from './abis'
import { normalizeAddress } from './helpers'
import { makeSharedReadCache, sharedCacheGet } from './internal/caches'
import type { SugarContext } from './internal/context'
import { clientCall } from './internal/interop'
import { paginate } from './internal/pagination'
import { bridgeToken, findToken, prepareTokens } from './models'
import { ADDRESS_ZERO, type Token } from './types'

export const balanceOf = Effect.fn('Sugar.Tokens.balanceOf')(function* (
  ctx: SugarContext,
  tokenAddress: Address,
  ownerAddress: Address,
) {
  return yield* ctx.read<bigint>(tokenAddress, abis.erc20, 'balanceOf', [ownerAddress])
})

export const getTokenBalance = Effect.fn('Sugar.Tokens.getTokenBalance')(function* (
  ctx: SugarContext,
  token: Token,
  ownerAddress?: Address,
) {
  if (!ownerAddress) throw new Error('Owner address is required to get token balance')
  return token.wrappedTokenAddress
    ? yield* ctx.rpc.read('getBalance', () => ctx.publicClient.getBalance({ address: ownerAddress }))
    : yield* clientCall(() => ctx.client.balanceOf(normalizeAddress(token.tokenAddress), ownerAddress))
})

export const getUserIcaBalance = Effect.fn('Sugar.Tokens.getUserIcaBalance')(function* (
  ctx: SugarContext,
  userIca: Address,
) {
  return yield* clientCall(() => ctx.client.balanceOf(ctx.settings.bridgeTokenAddress, userIca))
})

export const getAllTokens = Effect.fn('Sugar.Tokens.getAllTokens')(function* (
  ctx: SugarContext,
  listedOnly = false,
) {
  const cache = ctx.caches.tokenCache ??= yield* makeSharedReadCache(ctx.caches, (active, _key: 'catalog') =>
    paginate(active, 'tokens', (limit, offset) => active.readTask<unknown[]>(
      active.settings.sugarContractAddress,
      abis.sugar,
      'tokens',
      [limit, offset, ADDRESS_ZERO, []],
    )).pipe(Effect.map((raw) => prepareTokens(raw, active.settings))),
  )
  const tokens = yield* sharedCacheGet(ctx, cache, 'catalog')
  return listedOnly ? tokens.filter((token, index) => index === 0 || token.listed) : tokens
})

export const getToken = Effect.fn('Sugar.Tokens.getToken')(function* (
  ctx: SugarContext,
  reference: string | bigint | number,
) {
  return findToken(yield* clientCall(() => ctx.client.getAllTokens()), reference)
})

export const getBridgeToken = Effect.fn('Sugar.Tokens.getBridgeToken')(function* (
  ctx: SugarContext,
) {
  return bridgeToken(yield* clientCall(() => ctx.client.getAllTokens()), ctx.settings)
})
