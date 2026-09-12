import { Clock, Context, Effect, Layer, Redacted, Schedule, Schema } from 'effect'
import { decodeEventLog, encodeFunctionData, erc20Abi, keccak256, stringToHex } from 'viem'
import { Address, ChainId, EvmError, ExecuteInput, Hash, Hex, Id, Uint } from './model'
import { getJson } from './http'
import { Network, rpc } from './network'
import { Store } from './storage'
import { createWorkflow, runWorkflow, workflowStatus } from './workflows'
import type { WorkflowInput } from './workflows'

export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const SocketInput = Schema.Struct({
  originChainId: ChainId, destinationChainId: ChainId, inputToken: Address, outputToken: Address,
  inputAmount: Uint, userAddress: Address, receiverAddress: Address,
  slippage: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
})
export interface SocketInput extends Schema.Schema.Type<typeof SocketInput> {}
const Token = Schema.Struct({ address: Address, chainId: ChainId, symbol: Schema.String, decimals: Schema.Int })
export const SocketRoute = Schema.Struct({
  quoteId: Schema.String, expiresAt: Schema.Number,
  output: Schema.Struct({ token: Token, amount: Uint, minAmountOut: Uint }),
  approval: Schema.optionalKey(Schema.NullOr(Schema.Struct({ tokenAddress: Address, spenderAddress: Address, amount: Uint }))),
  txData: Schema.Struct({ kind: Schema.Literal('evm_tx'), object: Schema.Struct({ chainId: ChainId, to: Address, data: Hex, value: Uint }) }),
  routeTags: Schema.Array(Schema.String), estimatedTime: Schema.Number,
  routeDetails: Schema.optionalKey(Schema.Json), gasFee: Schema.optionalKey(Schema.Json),
})
export interface SocketRoute extends Schema.Schema.Type<typeof SocketRoute> {}
const QuoteResult = Schema.Struct({ originChainId: ChainId, destinationChainId: ChainId, userAddress: Address, receiverAddress: Address, input: Schema.Struct({ token: Token, amount: Uint }), routes: Schema.Array(SocketRoute) })
export const SocketQuote = Schema.Struct({ request: SocketInput, routes: Schema.Array(SocketRoute), fetchedAt: Schema.Number, endpoint: Schema.String })
export interface SocketQuote extends Schema.Schema.Type<typeof SocketQuote> {}
export const BridgeRecord = Schema.Struct({ id: Id, request: SocketInput, route: SocketRoute, workflowId: Id, requestHash: Schema.optionalKey(Hash) })
const StatusEnvelope = Schema.Struct({ success: Schema.Boolean, result: Schema.Json })
export interface SocketOptions { readonly socketUrl?: string; readonly socketApiKey?: Redacted.Redacted<string>; readonly socketAffiliate?: string }
export class Socket extends Context.Service<Socket, {
  readonly quote: (input: SocketInput) => Effect.Effect<SocketQuote, EvmError>
  readonly status: (quoteId: string, sourceHash?: string) => Effect.Effect<Schema.Json, EvmError>
  readonly catalog: (resource: 'supported-chains' | 'tokens/list' | 'tokens/search', params: ReadonlyArray<readonly [string, string]>) => Effect.Effect<Schema.Json, EvmError>
  readonly endpoint: string
}>()('@beegreat/evm/Socket') {}
export function socketLayer(options: SocketOptions) {
  const endpoint = options.socketUrl ?? (options.socketApiKey ? 'https://dedicated-backend.socket.tech' : 'https://public-backend.socket.tech')
  const get = Effect.fn('Socket.request')(function* (path: string, params: ReadonlyArray<readonly [string, string]>) {
    const url = new URL(`/v3/swap/${path}`, endpoint)
    for (const [key, value] of params) url.searchParams.set(key, value)
    const result = yield* getJson({ url: url.toString(), apiKey: options.socketApiKey, affiliate: options.socketAffiliate })
    const envelope = yield* Schema.decodeUnknownEffect(StatusEnvelope)(result).pipe(Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Socket returned an unexpected response.', retryable: false })))
    if (!envelope.success) return yield* new EvmError({ code: 'ProviderUnavailable', message: 'Socket could not fulfill this request. Check supported assets and quote amount.', retryable: false })
    return envelope.result
  })
  return Layer.succeed(Socket, Socket.of({ endpoint,
    quote: Effect.fn('Socket.quote')(function* (input) {
      if (BigInt(input.inputAmount) === 0n) return yield* new EvmError({ code: 'InvalidInput', message: 'Bridge amount must be positive.', retryable: false })
      const payload = yield* get('quote', [['userOps', 'tx'], ...Object.entries(input).map(([key, value]) => [key, String(value)] as const)])
      const result = yield* Schema.decodeUnknownEffect(QuoteResult)(payload).pipe(Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Socket quote schema changed or no executable EVM route was returned.', retryable: false })))
      if (result.originChainId !== input.originChainId || result.destinationChainId !== input.destinationChainId || !same(result.userAddress, input.userAddress) || !same(result.receiverAddress, input.receiverAddress) || !same(result.input.token.address, input.inputToken) || result.input.amount !== input.inputAmount) return yield* new EvmError({ code: 'InvalidState', message: 'Socket quote does not match the requested transfer.', retryable: false })
      const now = yield* Clock.currentTimeMillis
      const routes = result.routes.filter(route => route.expiresAt * 1000 > now && route.txData.object.chainId === input.originChainId && route.output.token.chainId === input.destinationChainId && same(route.output.token.address, input.outputToken))
      if (!routes.length) return yield* new EvmError({ code: 'ProviderUnavailable', message: 'No current EVM route is available for this pair and amount.', retryable: false })
      return { request: input, routes, fetchedAt: now, endpoint }
    }),
    status: Effect.fn('Socket.status')((quoteId, sourceHash) => get('status', [['quoteId', quoteId], ...(sourceHash ? [['srcTxHash', sourceHash] as const] : [])])),
    catalog: Effect.fn('Socket.catalog')((resource, params) => get(resource, params)),
  }))
}
export const BridgePrepare = Schema.Struct({ ...SocketInput.fields, key: Id, routeIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))), policy: Schema.optionalKey(Id) })
export const prepareBridge = Effect.fn('Bridge.prepare')(function* (input: Schema.Schema.Type<typeof BridgePrepare>) {
  const id = keccak256(stringToHex(`bridge:${input.key}`))
  const store = yield* Store
  const existing = yield* store.document(`bridge:${id}`)
  const request = Schema.decodeUnknownSync(SocketInput)(input)
  const requestHash = keccak256(stringToHex(JSON.stringify({ request, policy: input.policy ?? null, routeIndex: input.routeIndex ?? null })))
  if (existing !== null) {
    const record = Schema.decodeUnknownSync(BridgeRecord)(existing)
    if (JSON.stringify(record.request) !== JSON.stringify(request) || record.requestHash && record.requestHash !== requestHash) return yield* new EvmError({ code: 'IdempotencyConflict', message: 'Bridge key belongs to another transfer, policy or route selection.', retryable: false })
    return { bridge: record, workflow: yield* workflowStatus(record.workflowId) }
  }
  const quote = yield* (yield* Socket).quote(request)
  const route = quote.routes[input.routeIndex ?? Math.max(0, quote.routes.findIndex(r => r.routeTags.includes('SUGGESTED')))]
  if (!route) return yield* new EvmError({ code: 'InvalidInput', message: 'Selected Socket route does not exist.', retryable: false })
  const connection = yield* (yield* Network).client(input.originChainId)
  const steps: WorkflowInput['steps'][number][] = []
  const base = { chainId: input.originChainId, account: input.userAddress, key: input.key, policy: input.policy }
  if (route.approval) {
    const approval = route.approval
    if (!same(approval.tokenAddress, input.inputToken) || BigInt(approval.amount) > BigInt(input.inputAmount) || same(input.inputToken, NATIVE)) return yield* new EvmError({ code: 'InvalidState', message: 'Socket requested an unexpected token approval.', retryable: false })
    const allowance = yield* rpc(() => connection.readContract({ address: input.inputToken, abi: erc20Abi, functionName: 'allowance', args: [input.userAddress, approval.spenderAddress] }))
    if (allowance < BigInt(approval.amount)) {
      if (allowance > 0n) steps.push({ label: 'Reset token allowance', intent: { ...base, to: input.inputToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spenderAddress, 0n] }), value: '0' } })
      steps.push({ label: 'Approve bridge amount', intent: { ...base, to: input.inputToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spenderAddress, BigInt(approval.amount)] }), value: '0' }, check: { call: { chainId: input.originChainId, address: input.inputToken, signatures: ['function allowance(address owner,address spender) view returns(uint256)'], functionName: 'allowance', args: [input.userAddress, approval.spenderAddress] }, comparison: 'atLeast', expected: approval.amount } })
    }
  }
  if (same(input.inputToken, NATIVE) && route.txData.object.value !== input.inputAmount) return yield* new EvmError({ code: 'InvalidState', message: 'Socket native value differs from the approved input amount.', retryable: false })
  steps.push({ label: 'Submit Socket route', intent: { ...base, to: route.txData.object.to, data: route.txData.object.data, value: route.txData.object.value, deadline: route.expiresAt * 1000 } })
  const workflow = yield* createWorkflow({ key: id, steps })
  const bridge = { id, request, route, workflowId: workflow.id, requestHash }
  yield* store.putDocument(`bridge:${id}`, bridge)
  return { bridge, workflow: yield* workflowStatus(workflow.id) }
})
const ProviderStatus = Schema.Struct({
  quoteId: Schema.String, status: Schema.Literals(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED']),
  origin: Schema.optionalKey(Schema.Struct({ chainId: ChainId, userAddress: Address, txHash: Schema.NullOr(Hash) })),
  destination: Schema.optionalKey(Schema.Struct({ chainId: ChainId, receiverAddress: Address, txHash: Schema.NullOr(Hash) })),
})
export const bridgeStatus = Effect.fn('Bridge.status')(function* (id: string) {
  const bridge = yield* Schema.decodeUnknownEffect(BridgeRecord)(yield* (yield* Store).document(`bridge:${id}`)).pipe(Effect.mapError(() => new EvmError({ code: 'NotFound', message: 'Bridge operation not found.', retryable: false })))
  const source = yield* workflowStatus(bridge.workflowId)
  const finalId = source.operationIds.at(-1)
  const finalOperation = finalId && source.operationIds.length === source.workflow.steps.length ? yield* (yield* Store).get(finalId) : null
  const sourceHash = finalOperation && 'hash' in finalOperation.state ? finalOperation.state.hash ?? undefined : undefined
  const destination = yield* (yield* Socket).status(bridge.route.quoteId, sourceHash)
  const provider = yield* Schema.decodeUnknownEffect(ProviderStatus)(destination).pipe(Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Socket returned an invalid settlement status.', retryable: false })))
  if (provider.quoteId !== bridge.route.quoteId || provider.origin && (provider.origin.chainId !== bridge.request.originChainId || !same(provider.origin.userAddress, bridge.request.userAddress) || provider.origin.txHash && sourceHash && !same(provider.origin.txHash, sourceHash)) || provider.destination && (provider.destination.chainId !== bridge.request.destinationChainId || !same(provider.destination.receiverAddress, bridge.request.receiverAddress))) return yield* new EvmError({ code: 'InvalidState', message: 'Socket settlement does not match this bridge operation.', retryable: false })
  const proof = yield* verifyBridgeSettlement(bridge, provider, source.state === 'completed')
  return { bridge, source, destination, settlement: proof }
})
export const verifyBridgeSettlement = Effect.fn('Bridge.verifySettlement')(function* (bridge: Schema.Schema.Type<typeof BridgeRecord>, provider: Schema.Schema.Type<typeof ProviderStatus>, sourceComplete: boolean) {
  if (provider.status !== 'COMPLETED' || !sourceComplete) return { verified: false, reason: 'Source or destination settlement is still incomplete.', transactionHash: provider.destination?.txHash ?? null }
  const hash = provider.destination?.txHash
  if (!hash) return { verified: false, reason: 'Provider reports completion without a destination transaction hash.', transactionHash: null }
  const result = yield* Effect.gen(function* () {
    const client = yield* (yield* Network).client(bridge.request.destinationChainId)
    const receipt = yield* rpc(() => client.getTransactionReceipt({ hash }))
    const block = yield* rpc(() => client.getBlock({ blockNumber: receipt.blockNumber }))
    if (receipt.status !== 'success' || block.hash !== receipt.blockHash) return { verified: false, reason: 'Destination receipt is reverted or no longer canonical.', transactionHash: hash }
    let received = 0n
    if (same(bridge.request.outputToken, NATIVE)) {
      const transaction = yield* rpc(() => client.getTransaction({ hash }))
      if (transaction.to && same(transaction.to, bridge.request.receiverAddress)) received = transaction.value
    } else {
      for (const log of receipt.logs) {
        if (!same(log.address, bridge.request.outputToken)) continue
        const decoded = yield* Effect.try({ try: () => decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics }), catch: () => null }).pipe(Effect.orElseSucceed(() => null))
        if (decoded && same(decoded.args.to, bridge.request.receiverAddress)) received += decoded.args.value
      }
    }
    const verified = received >= BigInt(bridge.route.output.minAmountOut) && received > 0n
    return { verified, reason: verified ? 'Canonical destination receipt contains the required transfer to the receiver.' : 'Receipt is included, but the required asset transfer is not independently verified. Internal native transfers require a trace.', transactionHash: hash }
  }).pipe(Effect.catch(() => Effect.succeed({ verified: false, reason: 'Destination RPC verification is unavailable. Provider completion remains unverified.', transactionHash: hash })))
  return result
})
export const runBridge = Effect.fn('Bridge.run')(function* (input: Schema.Schema.Type<typeof ExecuteInput>) {
  const bridge = yield* Schema.decodeUnknownEffect(BridgeRecord)(yield* (yield* Store).document(`bridge:${input.id}`)).pipe(Effect.mapError(() => new EvmError({ code: 'NotFound', message: 'Bridge operation not found.', retryable: false })))
  yield* runWorkflow({ id: bridge.workflowId, approval: input.approval })
  return yield* bridgeStatus(input.id)
})
const Terminal = Schema.Struct({ status: Schema.Literals(['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED']) })
export const waitBridge = Effect.fn('Bridge.wait')(function* (id: string) {
  return yield* bridgeStatus(id).pipe(Effect.repeat({ while: result => !Schema.is(Terminal)(result.destination), schedule: Schedule.spaced('5 seconds').pipe(Schedule.upTo({ times: 59 })) }))
})
