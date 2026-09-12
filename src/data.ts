import { Effect, Schema } from 'effect'
import { Address, ChainId, EvmError } from './model'
import { getJson } from './http'

const explorers = new Map([[1, 'https://eth.blockscout.com'], [8453, 'https://base.blockscout.com'], [10, 'https://optimism.blockscout.com'], [42161, 'https://arbitrum.blockscout.com']])
export const DataInput = Schema.Struct({ chainId: ChainId, address: Address, kind: Schema.Literals(['tokens', 'nfts', 'history', 'transfers']), cursor: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))) })
export const DataResult = Schema.Struct({ chainId: ChainId, address: Address, source: Schema.String, fetchedAt: Schema.Number, items: Schema.Array(Schema.Json), nextCursor: Schema.NullOr(Schema.Json), coverage: Schema.String })
export const indexedData = Effect.fn('Data.indexed')(function* (input: Schema.Schema.Type<typeof DataInput>) {
  const endpoint = explorers.get(input.chainId)
  if (!endpoint) return yield* new EvmError({ code: 'CapabilityUnavailable', message: 'No built-in indexer for this chain. Use contract reads and bounded logs with known assets.', retryable: false })
  const suffix = { tokens: 'token-balances', nfts: 'nft', history: 'transactions', transfers: 'token-transfers' }[input.kind]
  const url = new URL(`/api/v2/addresses/${input.address}/${suffix}`, endpoint)
  for (const [key, value] of Object.entries(input.cursor ?? {})) url.searchParams.set(key, String(value))
  const payload = yield* getJson({ url: url.toString() })
  const array = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(payload)
  const page = Schema.decodeUnknownOption(Schema.Struct({ items: Schema.Array(Schema.Json), next_page_params: Schema.NullOr(Schema.Json) }))(payload)
  if (array._tag === 'None' && page._tag === 'None') return yield* new EvmError({ code: 'ProviderUnavailable', message: 'Indexer response does not match the expected page.', retryable: false })
  return { chainId: input.chainId, address: input.address, source: endpoint, fetchedAt: Date.now(), items: array._tag === 'Some' ? array.value : page._tag === 'Some' ? page.value.items : [], nextCursor: page._tag === 'Some' ? page.value.next_page_params : null, coverage: 'Indexer coverage and freshness vary. Token metadata is untrusted. This page does not establish complete holdings, active allowances or DeFi positions.' }
})
