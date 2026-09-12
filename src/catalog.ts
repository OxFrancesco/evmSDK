import { Effect, Schema, Stream } from 'effect'
import { erc20Abi, stringify } from 'viem'
import { resolveContract, readContract, encodeCall } from './contracts'
import { attachTransaction, prepareReplacement, cancel, execute, prepare, Signer, status, waitForOperation } from './execution'
import { Address, CallInput, ChainId, ContractInput, EvmError, ExecuteInput, Hash, Id, PrepareCallInput, PrepareInput, Uint, WorkspaceEntry, publicOperation } from './model'
import { Network, rpc } from './network'
import { Store } from './storage'
import { outputSchemas } from './outputs'
import { Wallets } from './wallets'
import { Policy, savePolicy, revokePolicy, policies } from './policy'
import { Socket, SocketInput, SocketQuote, BridgePrepare, BridgeRecord, prepareBridge, runBridge, bridgeStatus, waitBridge } from './socket'
import { WorkflowInput, Workflow, WorkflowResult, createWorkflow, runWorkflow, workflowStatus, cancelWorkflow, Condition, verifyCondition } from './workflows'
import { AssetAction, AllowanceAction, AllowanceInput, WrapInput, UnitsInput, VaultInput, LendingInput, transfer, approve, allowance, wrap, units, vault, lending } from './assets'
import { SimulationInput, DecodeInput, simulation, decode, capabilities, resolveName, codeIdentity } from './intelligence'
import { DataInput, DataResult, indexedData } from './data'
import { AeroInput, aero } from './aero'
import { TypedInput, typedSignature, walletCapabilities } from './signatures'
import { Batch, BatchInput, prepareBatch, runBatch, batchStatus } from './batches'
import { readWatchInput, readWatchSample, readWatch, MonitorInput, Monitor, createMonitor, pollMonitor, acknowledgeMonitor, pauseMonitor } from './monitor'
import { BlockSample, WatchInput, watchBlocks } from './watch'

export type Services = Network | Store | Signer | Wallets | Socket
export interface Command {
  readonly name: string
  readonly description: string
  readonly inputSchema: ReturnType<typeof Schema.toJsonSchemaDocument>
  readonly outputSchema: ReturnType<typeof Schema.toJsonSchemaDocument>
  readonly run: (input: Schema.Json) => Effect.Effect<Schema.Json, EvmError, Services>
}

function command<A, I, B, R extends Services>(name: string, description: string, schema: Schema.Codec<A, I>, run: (input: A) => Effect.Effect<B, EvmError, R>, resultSchema?: Schema.Top): Command {
  const output = resultSchema ?? outputSchemas.get(name) ?? Schema.Never
  outputSchemas.set(name, output)
  return {
    name, description, inputSchema: Schema.toJsonSchemaDocument(schema), outputSchema: Schema.toJsonSchemaDocument(output),
    run: input => Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(error => new EvmError({ code: 'InvalidInput', message: error.message, retryable: false })),
      Effect.flatMap(run),
      Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(stringify(value) ?? 'null').pipe(
        Effect.mapError(() => new EvmError({ code: 'InvalidState', message: 'Command result could not be serialized.', retryable: false })),
      )),
      Effect.tap(value => Schema.is(output)(value) ? Effect.void : Effect.fail(new EvmError({ code: 'InvalidState', message: `Result does not match the published ${name} output schema.`, retryable: false }))),
    ),
  }
}

const empty = Schema.Struct({})
const operationId = Schema.Struct({ id: Id })
const accountInput = Schema.Struct({ chainId: ChainId, address: Address })

export const commands: ReadonlyArray<Command> = [
  command('inspect', 'Discover a verified ABI or supply abi/signatures. Resolves EIP-1967 implementation-slot proxies when discovering.', ContractInput, resolveContract),
  command('read', 'Call a contract at a recorded block. Integers serialize as decimal strings.', CallInput, readContract),
  command('prepare', 'Simulate and persist an unsigned raw transaction. value is wei. key is required and identifies this intent.', PrepareInput, input => prepare(input).pipe(Effect.map(publicOperation))),
  command('prepare-call', 'Encode a contract function, simulate it, and persist a transaction plan. Does not sign.', PrepareCallInput, Effect.fn('Commands.prepareCall')(function* (input) {
    const encoded = yield* encodeCall(input)
    return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: input.address, data: encoded.data, value: input.value, key: input.key, policy: input.policy, deadline: input.deadline }))
  })),
  command('execute', 'Execute an existing plan with exact approval or yolo. Re-execution reconciles or resubmits the same signed bytes.', ExecuteInput, input => execute(input).pipe(Effect.map(publicOperation))),
  command('status', 'Reconcile a persisted operation with its receipt. Never signs or broadcasts. Confirmed means included, not finalized.', operationId, input => status(input.id).pipe(Effect.map(publicOperation))),
  command('wait', 'Poll an operation for up to 30 passes, one second apart plus RPC time. Never broadcasts.', operationId, input => waitForOperation(input.id).pipe(Effect.map(publicOperation))),
  command('cancel', 'Cancel an unsigned prepared plan. Submitted transactions cannot be cancelled by this command.', operationId, input => cancel(input.id).pipe(Effect.map(publicOperation))),
  command('operations', 'List up to 100 most recent local operations. No network request.', empty, Effect.fn('Commands.operations')(function* () { return (yield* (yield* Store).list()).map(publicOperation) })),
  command('wallet', 'Return the configured signer address. Never returns secret material.', empty, Effect.fn('Commands.wallet')(function* () { const signer = yield* Signer; const external = signer.external ? yield* signer.external() : null; return { address: signer.account?.address ?? external?.address ?? null, source: signer.account ? 'sdk-or-environment' : external ? 'connected-wallet' : 'none' } })),
  command('balance', 'Read native balance at a recorded block. balanceWei is an integer decimal string.', accountInput, Effect.fn('Commands.balance')(function* (input) {
    const connection = yield* (yield* Network).client(input.chainId)
    const block = yield* rpc(() => connection.getBlockNumber())
    const balance = yield* rpc(() => connection.getBalance({ address: input.address, blockNumber: block }))
    return { ...input, block: block.toString(), balanceWei: balance.toString() }
  })),
  command('token', 'Read ERC-20 metadata and an account balance at the same block. amount uses token base units.', Schema.Struct({ ...accountInput.fields, token: Address }), Effect.fn('Commands.token')(function* (input) {
    const connection = yield* (yield* Network).client(input.chainId)
    const block = yield* rpc(() => connection.getBlockNumber())
    const [symbol, decimals, balance] = yield* Effect.all([
      rpc(() => connection.readContract({ address: input.token, abi: erc20Abi, functionName: 'symbol', blockNumber: block })),
      rpc(() => connection.readContract({ address: input.token, abi: erc20Abi, functionName: 'decimals', blockNumber: block })),
      rpc(() => connection.readContract({ address: input.token, abi: erc20Abi, functionName: 'balanceOf', args: [input.address], blockNumber: block })),
    ], { concurrency: 3 })
    return { ...input, block: block.toString(), symbol, decimals, amount: balance.toString() }
  })),
  command('block', 'Read the latest block or a specific block number. Quantities serialize as decimal strings.', Schema.Struct({ chainId: ChainId, number: Schema.optionalKey(Uint) }), Effect.fn('Commands.block')(function* (input) {
    const connection = yield* (yield* Network).client(input.chainId)
    const block = yield* rpc(() => connection.getBlock({ blockNumber: input.number === undefined ? undefined : BigInt(input.number) }))
    return { chainId: input.chainId, number: block.number?.toString() ?? null, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp.toString(), gasUsed: block.gasUsed.toString(), gasLimit: block.gasLimit.toString(), baseFeePerGas: block.baseFeePerGas?.toString() ?? null, transactions: block.transactions.length }
  })),
  command('transaction', 'Read a transaction by hash, including its raw calldata.', Schema.Struct({ chainId: ChainId, hash: Hash }), Effect.fn('Commands.transaction')(function* (input) {
    const connection = yield* (yield* Network).client(input.chainId)
    const transaction = yield* rpc(() => connection.getTransaction({ hash: input.hash }))
    return { chainId: input.chainId, hash: transaction.hash, from: transaction.from, to: transaction.to, nonce: transaction.nonce, valueWei: transaction.value.toString(), data: transaction.input, block: transaction.blockNumber?.toString() ?? null, gas: transaction.gas.toString(), gasPrice: transaction.gasPrice?.toString() ?? null }
  })),
  command('logs', 'Read logs in pages of at most 2000 blocks and 1000 records. nextBlock/nextOffset continue without silently dropping records.', Schema.Struct({ chainId: ChainId, address: Address, fromBlock: Uint, toBlock: Uint, offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) }), Effect.fn('Commands.logs')(function* (input) {
    const from = BigInt(input.fromBlock)
    const requestedTo = BigInt(input.toBlock)
    if (requestedTo < from) return yield* new EvmError({ code: 'InvalidInput', message: 'toBlock must be at least fromBlock.', retryable: false })
    const to = requestedTo < from + 1999n ? requestedTo : from + 1999n
    const connection = yield* (yield* Network).client(input.chainId)
    const logs = yield* rpc(() => connection.getLogs({ address: input.address, fromBlock: from, toBlock: to }))
    const offset = input.offset ?? 0
    const page = logs.slice(offset, offset + 1000)
    const hasMore = offset + page.length < logs.length
    return { logs: page.map(log => ({ address: log.address, data: log.data, topics: log.topics, block: log.blockNumber?.toString() ?? null, transactionHash: log.transactionHash, logIndex: log.logIndex, removed: log.removed })), fromBlock: from.toString(), toBlock: to.toString(), nextBlock: hasMore ? from.toString() : to < requestedTo ? (to + 1n).toString() : null, nextOffset: hasMore ? offset + page.length : 0 }
  })),
  command('workspace', 'List saved contract aliases.', empty, Effect.fn('Commands.workspace')(function* () { return yield* (yield* Store).entries() })),
  command('save', 'Save or update a chain-specific contract alias.', WorkspaceEntry, Effect.fn('Commands.save')(function* (input) { yield* (yield* Store).putEntry(input); return input })),
  command('remove', 'Remove a saved alias.', Schema.Struct({ name: Id }), Effect.fn('Commands.remove')(function* (input) { yield* (yield* Store).removeEntry(input.name); return { removed: input.name } })),

  command('capabilities', 'Probe chain methods, transaction fees, signer and Socket availability.', Schema.Struct({ chainId: ChainId }), input => capabilities(input.chainId), Schema.Struct({ chainId: ChainId, block: Uint, eip1559: Schema.Boolean, safeBlocks: Schema.Boolean, finalizedBlocks: Schema.Boolean, assetSimulation: Schema.Boolean, signer: Schema.NullOr(Schema.Struct({ address: Address, interactive: Schema.Boolean })), socketEndpoint: Schema.String })),
  command('wallets', 'List named connected wallets and the selected account.', empty, Effect.fn('Commands.wallets')(function* () { return yield* (yield* Wallets).list() }), Schema.Json),
  command('wallet-connect', 'Connect a browser, mobile or Crossmint smart wallet. Interactive terminals only; never exports keys.', Schema.Struct({ kind: Schema.Literals(['browser', 'walletconnect', 'crossmint']), chainId: ChainId, name: Id }), Effect.fn('Commands.walletConnect')(function* (input) { return yield* (yield* Wallets).connect(input.kind, input.chainId, input.name) }), Schema.Json),
  command('wallet-select', 'Select a previously connected named wallet.', Schema.Struct({ name: Id }), Effect.fn('Commands.walletSelect')(function* (input) { return yield* (yield* Wallets).select(input.name) }), Schema.Json),
  command('wallet-disconnect', 'Disconnect and forget a named wallet connection.', Schema.Struct({ name: Id }), Effect.fn('Commands.walletDisconnect')(function* (input) { return yield* (yield* Wallets).disconnect(input.name) }), Schema.Struct({ removed: Schema.String })),
  command('batch-prepare', 'Prepare a wallet batch with explicit atomicity and optional paymaster. Requires an EIP-5792 wallet.', BatchInput, prepareBatch, Batch),
  command('batch-run', 'Submit an approved wallet batch once. Persist its ID before contacting the wallet.', ExecuteInput, runBatch, Batch),
  command('batch-status', 'Query the same wallet batch ID after restart or lost responses.', operationId, input => batchStatus(input.id), Batch),
  command('wallet-capabilities', 'Query EIP-5792 batching and sponsorship support in the connected wallet.', Schema.Struct({ chainId: ChainId }), input => walletCapabilities(input.chainId), Schema.Struct({ available: Schema.Boolean, capabilities: Schema.NullOr(Schema.Json) })),
  command('sign-typed-data', 'Preview an EIP-712 digest. Sign only with exact approval or yolo. No broadcast.', TypedInput, typedSignature, Schema.Struct({ fingerprint: Hash, signature: Schema.NullOr(Schema.String), account: Address, chainId: ChainId })),
  command('attach-transaction', 'Recover a lost wallet response by verifying the actual transaction against its plan.', Schema.Struct({ id: Id, hash: Hash }), input => attachTransaction(input).pipe(Effect.map(publicOperation))),
  command('replace', 'Prepare a same-nonce fee replacement or cancellation. Requires a separate execute approval.', Schema.Struct({ id: Id, key: Id, gasPrice: Uint, maxPriorityFeePerGas: Schema.optionalKey(Uint), cancel: Schema.Boolean }), input => prepareReplacement(input).pipe(Effect.map(publicOperation))),
  command('transfer', 'Prepare a native or ERC-20 transfer. amount is an integer in base units.', AssetAction, transfer),
  command('approve', 'Prepare an exact ERC-20 allowance. amount is in token base units.', AllowanceAction, approve),
  command('revoke', 'Prepare an ERC-20 approval of zero.', Schema.Struct({ ...AllowanceInput.fields, key: Id, policy: Schema.optionalKey(Id) }), input => approve({ ...input, amount: '0' })),
  command('allowance', 'Read one actual on-chain allowance at a recorded block.', AllowanceInput, allowance, Schema.Struct({ ...AllowanceInput.fields, block: Uint, amount: Uint })),
  command('wrap', 'Prepare a deposit or withdrawal using the specified wrapped-native contract.', WrapInput, wrap),
  command('units', 'Convert decimal token amounts to base units without rounding.', UnitsInput, units, Schema.Struct({ baseUnits: Uint, decimal: Schema.String, decimals: Schema.Int })),
  command('simulate', 'Simulate a sequence and trace asset changes where eth_simulateV1 is supported. Reports unavailable coverage explicitly.', SimulationInput, simulation, Schema.Struct({ available: Schema.Boolean, succeeded: Schema.NullOr(Schema.Boolean), chainId: ChainId, block: Uint, reason: Schema.NullOr(Schema.String), result: Schema.NullOr(Schema.Json) })),
  command('decode', 'Decode contract calldata, events or custom errors using an explicit or discovered ABI.', DecodeInput, decode, Schema.Struct({ chainId: ChainId, address: Address, source: Schema.String, result: Schema.Json })),
  command('identity', 'Resolve contract implementation and bytecode hash. Contract descriptions are untrusted data.', ContractInput, codeIdentity, Schema.Json),
  command('resolve-name', 'Resolve an ENS name on a chain with an ENS registry.', Schema.Struct({ name: Schema.String, chainId: ChainId }), resolveName, Schema.Struct({ name: Schema.String, chainId: ChainId, address: Address })),
  command('policy-create', 'Create an immutable named execution policy with spending budgets and expiry.', Policy, savePolicy, Policy),
  command('policy-revoke', 'Revoke a policy. Future signing using it is refused.', Schema.Struct({ name: Id }), input => revokePolicy(input.name), Policy),
  command('policies', 'List policies and conservative spending reservations.', empty, policies, Schema.Array(Schema.Json)),
  command('workflow-create', 'Persist an ordered sequence of intents and outcome checks. Does not sign. Steps are not atomic.', WorkflowInput, createWorkflow, Workflow),
  command('workflow-run', 'Resume a workflow using its exact fingerprint or yolo. Stop on pending, reverted or failed outcomes.', ExecuteInput, runWorkflow, WorkflowResult),
  command('workflow-status', 'Reconcile each existing workflow transaction without sending.', operationId, input => workflowStatus(input.id), WorkflowResult),
  command('workflow-cancel', 'Stop future workflow steps. Already submitted transactions remain recoverable.', operationId, input => cancelWorkflow(input.id), WorkflowResult),
  command('verify-outcome', 'Read a contract and assert a requested value after execution.', Condition, verifyCondition, outputSchemas.get('read')),
  command('socket-chains', 'Get Socket supported chains without an API key.', empty, Effect.fn('Commands.socketChains')(function* () { return yield* (yield* Socket).catalog('supported-chains', []) }), Schema.Json),
  command('socket-tokens', 'Search Socket assets by chain and symbol or address.', Schema.Struct({ chainId: ChainId, query: Schema.String }), Effect.fn('Commands.socketTokens')(function* (input) { const result = yield* (yield* Socket).catalog('tokens/search', [['q', input.query]]); const page = yield* Schema.decodeUnknownEffect(Schema.Struct({ tokens: Schema.Record(Schema.String, Schema.Array(Schema.Json)) }))(result).pipe(Effect.mapError(() => new EvmError({ code: 'ProviderUnavailable', message: 'Socket token search response changed.', retryable: false }))); return { chainId: input.chainId, tokens: page.tokens[String(input.chainId)] ?? [] } }), Schema.Json),
  command('socket-quote', 'Get executable Socket V3 swap or bridge quotes. No signing. Public endpoint works without credentials.', SocketInput, Effect.fn('Commands.socketQuote')(function* (input) { return yield* (yield* Socket).quote(input) }), SocketQuote),
  command('bridge-prepare', 'Get a fresh Socket route and persist exact approval and route steps for review.', BridgePrepare, prepareBridge, Schema.Struct({ bridge: BridgeRecord, workflow: WorkflowResult })),
  command('bridge-run', 'Run persisted bridge steps with exact workflow approval or yolo, then inspect destination settlement.', ExecuteInput, runBridge, Schema.Json),
  command('bridge-status', 'Reconcile source operations and Socket destination status. Source inclusion is not bridge completion.', operationId, input => bridgeStatus(input.id), Schema.Json),
  command('bridge-wait', 'Poll bridge settlement for up to 60 passes. An unresolved bridge remains recoverable.', operationId, input => waitBridge(input.id), Schema.Json),
  command('swap', 'Prepare a Socket same-chain swap as a resumable workflow.', BridgePrepare, input => input.originChainId === input.destinationChainId ? prepareBridge(input) : Effect.fail(new EvmError({ code: 'InvalidInput', message: 'For cross-chain movement use bridge-prepare.', retryable: false })), Schema.Struct({ bridge: BridgeRecord, workflow: WorkflowResult })),
  command('portfolio', 'Read indexed token holdings, NFTs or history with explicit coverage and pagination.', DataInput, indexedData, DataResult),
  command('aero', 'Run an existing Aero read or transaction planner. With key, transaction plans become an EVM workflow.', AeroInput, aero, Schema.Struct({ result: Schema.Json, workflow: Schema.NullOr(Workflow) })),
  command('vault', 'Prepare an ERC-4626 deposit or redemption workflow with an outcome check.', VaultInput, vault, Workflow),
  command('lending', 'Prepare an Aave-compatible supply or withdrawal workflow for an explicit pool.', LendingInput, lending, Workflow),
  command('watch-contract', 'Watch balances, allowances or positions through a contract read. Persist previous values and report changes across restarts.', readWatchInput, input => Stream.runCollect(readWatch(input)), Schema.Array(readWatchSample)),
  command('monitor-create', 'Persist a contract event monitor with confirmations and a durable cursor.', MonitorInput, createMonitor, Monitor),
  command('monitor-poll', 'Fetch the next event batch. Repeats the same batch until acknowledged; reorgs request replay.', Schema.Struct({ name: Id }), input => pollMonitor(input.name), Schema.NullOr(Schema.Json)),
  command('monitor-ack', 'Acknowledge processing of the exact event batch before advancing the cursor.', Schema.Struct({ name: Id, id: Hash }), input => acknowledgeMonitor(input.name, input.id), Monitor),
  command('monitor-pause', 'Pause or resume a monitor without losing its cursor.', Schema.Struct({ name: Id, paused: Schema.Boolean }), input => pauseMonitor(input.name, input.paused), Monitor),
  command('monitors', 'List stored monitors.', empty, Effect.fn('Commands.monitors')(function* () { return yield* (yield* Store).documents('monitor:') }), Schema.Array(Monitor)),
  command('watch', 'Sample latest blocks at bounded intervals. CLI emits one JSON line per sample; SDK dispatch and TUI return the collected array.', WatchInput, input => Stream.runCollect(watchBlocks(input))),
]

export function discover() {
  return {
    version: 1,
    commands: commands.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })),
    errorSchema: Schema.toJsonSchemaDocument(EvmError),
    streamingOutputs: { watch: Schema.toJsonSchemaDocument(BlockSample), 'watch-contract': Schema.toJsonSchemaDocument(readWatchSample) },
    conventions: {
      input: 'evm <command> --input <json>, --file <path>, or --stdin',
      execution: 'prepare or prepare-call, then execute --input {"id":"..."} --yolo or --approve <fingerprint>',
      quantities: 'All on-chain integers use decimal strings. Native value and balance use wei. Token amounts use base units.',
      output: '{"version":1,"ok":true,"command":"...","result":...} or {"version":1,"ok":false,"error":{"code":"...","message":"...","retryable":false}}',
      exitCodes: { success: 0, error: 1 },
      signing: 'Browser wallet or WalletConnect in interactive terminals. EVM_PRIVATE_KEY or an SDK-injected LocalAccount/ExternalSigner for unattended agents. Keys are never command arguments. yolo removes toolkit approval only.',
      mcp: 'evm mcp exposes the same catalog over stdio. It is noninteractive; browser wallets require the TUI.',
    },
  }
}

export const dispatch = Effect.fn('Commands.dispatch')(function* (name: string, input: Schema.Json) {
  const selected = commands.find(command => command.name === name)
  if (!selected) return yield* new EvmError({ code: 'InvalidInput', message: `Unknown command ${name}. Run evm discover.`, retryable: false })
  return yield* selected.run(input)
})
