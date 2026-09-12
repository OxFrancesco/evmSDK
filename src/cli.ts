#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { Cause, Effect, Option, Schema, Stream } from 'effect'
import { stringify } from 'viem'
import { discover, dispatch } from './catalog'
import { EvmError } from './model'
import { environmentOptions, runtimeLayer } from './runtime'
import { readWatch, readWatchInput } from './monitor'
import { WatchInput, watchBlocks } from './watch'

const approvalCommands = ['execute', 'workflow-run', 'bridge-run', 'sign-typed-data', 'batch-run']

const program = Effect.gen(function* () {
  const parsed = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
      input: { type: 'string' }, file: { type: 'string' }, stdin: { type: 'boolean' },
      rpc: { type: 'string' }, database: { type: 'string' }, yolo: { type: 'boolean' },
      smart: { type: 'boolean' }, browser: { type: 'boolean' }, chain: { type: 'string' }, name: { type: 'string' }, approve: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } }),
    catch: () => new EvmError({ code: 'InvalidInput', message: 'Invalid arguments. Run evm discover for commands and input schemas.', retryable: false }),
  })
  const [first = 'discover', ...extra] = parsed.positionals
  const walletAction = first === 'wallet' && extra.length === 1 ? extra[0] : undefined
  const aliases = new Map([['connect', 'wallet-connect'], ['status', 'wallets'], ['disconnect', 'wallet-disconnect'], ['select', 'wallet-select']])
  const name = walletAction ? aliases.get(walletAction) ?? first : first
  if (extra.length && (!walletAction || !aliases.has(walletAction))) return yield* new EvmError({ code: 'InvalidInput', message: 'Supply one command and JSON through --input, --file, or --stdin.', retryable: false })
  if (name === 'discover' || parsed.values.help) {
    process.stdout.write(`${stringify(discover())}\n`)
    return
  }
  const values = parsed.values
  if (Number(values.input !== undefined) + Number(values.file !== undefined) + Number(values.stdin === true) > 1) return yield* new EvmError({ code: 'InvalidInput', message: 'Choose exactly one of --input, --file, or --stdin.', retryable: false })
  if ((values.yolo || values.approve) && !approvalCommands.includes(name)) return yield* new EvmError({ code: 'InvalidInput', message: '--yolo and --approve apply to execute, workflow-run, bridge-run, batch-run and sign-typed-data.', retryable: false })
  if (values.yolo && values.approve) return yield* new EvmError({ code: 'InvalidInput', message: 'Choose --yolo or --approve, not both.', retryable: false })
  const options = yield* environmentOptions()
  const configured = { ...options, interactive: Boolean(process.stdin.isTTY), rpcUrl: values.rpc ?? options.rpcUrl, database: values.database ?? options.database }
  if (name === 'mcp') {
    const { runMcp } = yield* Effect.promise(() => import('./mcp'))
    yield* Effect.promise(() => runMcp({ ...configured, interactive: false })); return
  }
  if (name === 'tui') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return yield* new EvmError({ code: 'InvalidInput', message: 'The TUI requires an interactive terminal. Use evm discover for agent commands.', retryable: false })
    const { runTui } = yield* Effect.promise(() => import('./tui/run'))
    yield* Effect.promise(() => runTui(configured))
    return
  }
  const text = yield* Effect.tryPromise({
    try: () => values.stdin ? Bun.stdin.text() : values.file ? Bun.file(values.file).text() : Promise.resolve(values.input ?? '{}'),
    catch: () => new EvmError({ code: 'InvalidInput', message: 'Cannot read the input file or stdin.', retryable: false }),
  })
  let input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'Input must be valid JSON.', retryable: false })))
  if (walletAction && !values.input && !values.file && !values.stdin) {
    input = walletAction === 'connect' ? { kind: values.smart ? 'crossmint' : values.browser ? 'browser' : 'walletconnect', chainId: Number(values.chain ?? '8453'), name: values.name ?? 'main' } : walletAction === 'status' ? {} : { name: values.name ?? 'main' }
  }
  if (approvalCommands.includes(name)) {
    const payload = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(input).pipe(Effect.mapError(() => new EvmError({ code: 'InvalidInput', message: 'Command input must be an object.', retryable: false })))
    if ((values.yolo || values.approve) && payload.approval) return yield* new EvmError({ code: 'InvalidInput', message: 'Specify approval in flags or input, not both.', retryable: false })
    input = { ...payload, approval: values.yolo ? { _tag: 'yolo' } : values.approve ? { _tag: 'approved', fingerprint: values.approve } : payload.approval ?? { _tag: 'required' } }
  }
  if (name === 'watch-contract') {
    const watchInput = yield* Schema.decodeUnknownEffect(readWatchInput)(input).pipe(Effect.mapError(error => new EvmError({ code: 'InvalidInput', message: error.message, retryable: false })))
    yield* readWatch(watchInput).pipe(Stream.runForEach(result => Effect.sync(() => { process.stdout.write(`${stringify({ version: 1, ok: true, command: name, result })}\n`) })), Effect.provide(runtimeLayer(configured))); return
  }
  if (name === 'watch') {
    const watchInput = yield* Schema.decodeUnknownEffect(WatchInput)(input, { onExcessProperty: 'error' }).pipe(Effect.mapError(error => new EvmError({ code: 'InvalidInput', message: error.message, retryable: false })))
    yield* watchBlocks(watchInput).pipe(Stream.runForEach(result => Effect.sync(() => { process.stdout.write(`${stringify({ version: 1, ok: true, command: name, result })}\n`) })), Effect.provide(runtimeLayer(configured)))
    return
  }
  const result = yield* dispatch(name, input).pipe(Effect.provide(runtimeLayer(configured)))
  process.stdout.write(`${stringify({ version: 1, ok: true, command: name, result })}\n`)
})

if (import.meta.main) {
  await Effect.runPromise(program.pipe(Effect.catchCause(cause => Effect.sync(() => {
    const failure = Cause.findErrorOption(cause)
    const error = Option.isSome(failure) && failure.value instanceof EvmError ? failure.value : new EvmError({ code: 'InvalidState', message: 'Command failed unexpectedly. No success is assumed; inspect persisted operations before retrying execution.', retryable: false })
    process.stdout.write(`${JSON.stringify({ version: 1, ok: false, error: { code: error.code, message: error.message, retryable: error.retryable } })}\n`)
    process.exitCode = 1
  }))))
}
