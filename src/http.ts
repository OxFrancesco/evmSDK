import { Effect, Redacted, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { EvmError } from './model'

export interface ApiRequest { readonly url: string; readonly apiKey?: Redacted.Redacted<string>; readonly affiliate?: string }
export const getJson = Effect.fn('Http.getJson')(function* (input: ApiRequest) {
  let request = HttpClientRequest.get(input.url).pipe(HttpClientRequest.acceptJson)
  if (input.apiKey) request = request.pipe(HttpClientRequest.setHeader('x-api-key', Redacted.value(input.apiKey)))
  if (input.affiliate) request = request.pipe(HttpClientRequest.setHeader('affiliate', input.affiliate))
  const response = yield* HttpClient.execute(request).pipe(Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Provider connection failed. Retry this read later.', retryable: true })))
  if (response.status < 200 || response.status >= 300) return yield* new EvmError({ code: 'ProviderUnavailable', message: `Provider returned HTTP ${response.status}. Request ${response.headers['server-req-id'] ?? 'unavailable'}.`, retryable: response.status === 429 || response.status >= 500 })
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Provider returned invalid JSON.', retryable: false })))
}, effect => effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout('30 seconds'), Effect.mapError(error => error instanceof EvmError ? error : new EvmError({ code: 'ProviderUnavailable', message: 'Provider request timed out. Retry this read later.', retryable: true }))))
