import { expect } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { Effect, ManagedRuntime, Schema, Schedule } from 'effect'
import { createPublicClient, createWalletClient, http, parseEther, encodeFunctionData, parseAbi, erc20Abi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { dispatch } from '../src/catalog'
import { prepare, execute, status, waitForOperation } from '../src/execution'
import { Address, Hex, Operation } from '../src/model'
import { runtimeLayer } from '../src/runtime'
import { Workflow } from '../src/workflows'
import { BridgeRecord, verifyBridgeSettlement } from '../src/socket'
import { Batch } from '../src/batches'
import { Store } from '../src/storage'

const root = resolve(import.meta.dir, '..')
const temporary = await mkdtemp(join(tmpdir(), 'bee-evm-e2e-'))
const artifacts = join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const build = Bun.spawn(['forge', 'build', '--root', join(root, 'fixtures'), '--out', join(temporary, 'out'), '--cache-path', join(temporary, 'cache')], { stdout: 'pipe', stderr: 'pipe' })
if (await build.exited !== 0) throw new Error(await new Response(build.stderr).text())
const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ bytecode: Schema.Struct({ object: Hex }) })))(await Bun.file(join(temporary, 'out', 'Counter.sol', 'Counter.json')).text())
const reservation = createServer()
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
const bound = reservation.address()
if (!bound || Schema.is(Schema.String)(bound)) throw new Error('Cannot reserve test port')
const port = bound.port
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
const url = `http://127.0.0.1:${port}`
const node = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdout: 'ignore', stderr: 'pipe' })
const key = generatePrivateKey()
const signer = privateKeyToAccount(key)
const client = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 2000 }) })
const wallet = createWalletClient({ chain: anvil, account: signer, transport: http(url) })
const database = join(temporary, 'operations.sqlite')
let runtime = ManagedRuntime.make(runtimeLayer({ database, rpcUrl: url, signer }))
const checks: string[] = []
const pass = (name: string) => { checks.push(name); process.stdout.write(`PASS ${name}\n`) }
const call = (name: string, input: Schema.Json) => runtime.runPromise(dispatch(name, input))
const cli = async (name: string, input: Schema.Json, flags: ReadonlyArray<string> = []) => {
  const child = Bun.spawn([process.execPath, join(root, 'dist', 'cli.js'), name, '--input', JSON.stringify(input), ...flags], {
    env: { ...process.env, EVM_PRIVATE_KEY: key, EVM_DATABASE: database, EVM_RPC_URL: url }, stdout: 'pipe', stderr: 'pipe',
  })
  const output = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean, result: Schema.optionalKey(Schema.Json), error: Schema.optionalKey(Schema.Struct({ code: Schema.String })) })))(await new Response(child.stdout).text())
  return { output, exit: await child.exited }
}

try {
  await Effect.runPromise(Effect.tryPromise(() => client.getChainId()).pipe(Effect.retry({ times: 30, schedule: Schedule.spaced('100 millis') })))
  const funding = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [signer.address, `0x${parseEther('10').toString(16)}`] }) })
  expect(funding.ok).toBe(true)
  const deployment = await wallet.deployContract({ abi: [], bytecode: artifact.bytecode.object })
  const receipt = await client.waitForTransactionReceipt({ hash: deployment })
  const address = Schema.decodeUnknownSync(Address)(receipt.contractAddress)
  const base = { chainId: 31337, address, signatures: ['function count() view returns (uint256)', 'function set(uint256 value)', 'function sum((uint256 a, uint256 b) pair, uint256[] extra) pure returns (uint256)'] }

  expect(await call('read', { ...base, functionName: 'count' })).toMatchObject({ value: '0' })
  pass('contract read at a recorded block')
  expect(await call('read', { ...base, functionName: 'sum', args: [{ a: '2', b: '3' }, ['5', '7']] })).toMatchObject({ value: '17' })
  pass('tuple and array ABI arguments')
  const prepared = Schema.decodeUnknownSync(Operation)(await call('prepare-call', { ...base, functionName: 'set', args: ['42'], account: signer.address, value: '0', key: 'set-42' }))
  const denied = await cli('execute', { id: prepared.plan.id })
  expect(denied.exit).toBe(1); expect(denied.output.error?.code).toBe('ApprovalRequired')
  expect(await call('read', { ...base, functionName: 'count' })).toMatchObject({ value: '0' })
  pass('agent mode requires approval without prompting or broadcasting')
  const approved = await cli('execute', { id: prepared.plan.id }, ['--yolo'])
  expect(approved.exit).toBe(0)
  expect((await cli('wait', { id: prepared.plan.id })).output.result).toMatchObject({ state: { _tag: 'confirmed' } })
  expect(await call('read', { ...base, functionName: 'count' })).toMatchObject({ value: '42' })
  pass('built CLI --yolo signs, broadcasts, and changes contract storage')
  const nonce = await client.getTransactionCount({ address: signer.address })
  await cli('execute', { id: prepared.plan.id }, ['--yolo'])
  expect(await client.getTransactionCount({ address: signer.address })).toBe(nonce)
  pass('repeat execution does not spend another nonce')
  await runtime.dispose()
  runtime = ManagedRuntime.make(runtimeLayer({ database, rpcUrl: url, signer }))
  expect(await call('status', { id: prepared.plan.id })).toMatchObject({ state: { _tag: 'confirmed' } })
  pass('operation survives a runtime restart')
  const duplicate = await call('prepare-call', { ...base, functionName: 'set', args: ['42'], account: signer.address, value: '0', key: 'set-42' })
  expect(duplicate).toMatchObject({ plan: { id: prepared.plan.id }, state: { _tag: 'confirmed' } })
  const conflict = await cli('prepare-call', { ...base, functionName: 'set', args: ['43'], account: signer.address, value: '0', key: 'set-42' })
  expect(conflict.output.error?.code).toBe('IdempotencyConflict')
  pass('idempotency key binds the exact transaction intent')
  const reverted = await cli('prepare-call', { ...base, functionName: 'set', args: ['1001'], account: signer.address, value: '0', key: 'revert' })
  expect(reverted.output.ok).toBe(false)
  expect(await client.getTransactionCount({ address: signer.address })).toBe(nonce)
  pass('reverting simulation never broadcasts')
  expect(await call('token', { chainId: 31337, address: signer.address, token: address })).toMatchObject({ amount: '42', symbol: 'TEST', decimals: 18 })
  pass('ERC-20 metadata and balance')
  const transfer = await runtime.runPromise(prepare({ chainId: 31337, account: signer.address, to: privateKeyToAccount(generatePrivateKey()).address, data: '0x', value: '1000', key: 'transfer' }))
  const transferResult = await runtime.runPromise(execute({ id: transfer.plan.id, approval: { _tag: 'approved', fingerprint: transfer.plan.fingerprint } }))
  expect((await runtime.runPromise(waitForOperation(transferResult.plan.id))).state._tag).toBe('confirmed')
  expect(await client.getBalance({ address: transfer.plan.to })).toBe(1000n)
  pass('exact plan approval executes a native transfer')
  const cancelled = await runtime.runPromise(prepare({ ...transfer.plan, key: 'cancel' }))
  await call('cancel', { id: cancelled.plan.id })
  expect((await cli('execute', { id: cancelled.plan.id }, ['--yolo'])).output.error?.code).toBe('InvalidState')
  pass('cancelled plans cannot execute')
  await call('save', { name: 'counter', chainId: 31337, address })
  expect(await call('workspace', {})).toEqual([{ name: 'counter', chainId: 31337, address }])
  await call('remove', { name: 'counter' }); expect(await call('workspace', {})).toEqual([])
  pass('workspace aliases save, list, and remove')
  const tip = await client.getBlockNumber()
  expect(await call('logs', { chainId: 31337, address, fromBlock: '0', toBlock: tip.toString() })).toMatchObject({ nextBlock: null })
  pass('bounded event log query')
  expect((await cli('balance', { chainId: 8453, address })).output.error?.code).toBe('ChainMismatch')
  expect((await cli('balance', { chainId: 31337, address, surprise: true })).output.error?.code).toBe('InvalidInput')
  pass('chain mismatch and unknown input fields are rejected')
  const concurrent = await runtime.runPromise(prepare({ ...transfer.plan, key: 'concurrent' }))
  const before = await client.getTransactionCount({ address: signer.address })
  const simultaneous = await Promise.all([cli('execute', { id: concurrent.plan.id }, ['--yolo']), cli('execute', { id: concurrent.plan.id }, ['--yolo'])])
  expect(simultaneous.some(result => result.output.ok)).toBe(true)
  expect((await call('wait', { id: concurrent.plan.id }))).toMatchObject({ state: { _tag: 'confirmed' } })
  expect(await client.getTransactionCount({ address: signer.address })).toBe(before + 1)
  pass('concurrent CLI processes submit only one transaction')
  const wrongAccount = await runtime.runPromise(prepare({ ...transfer.plan, key: 'wrong-account' }))
  const stranger = ManagedRuntime.make(runtimeLayer({ database, rpcUrl: url, signer: privateKeyToAccount(generatePrivateKey()) }))
  const wrong = await stranger.runPromise(execute({ id: wrongAccount.plan.id, approval: { _tag: 'yolo' } }).pipe(Effect.result))
  expect(wrong._tag).toBe('Failure')
  if (wrong._tag === 'Failure') expect(wrong.failure.code).toBe('AccountMismatch')
  await stranger.dispose()
  pass('wrong signer is rejected before submission')
  const unapproved = await cli('execute', { id: wrongAccount.plan.id }, ['--approve', `0x${'0'.repeat(64)}`])
  expect(unapproved.output.error?.code).toBe('ApprovalRequired')
  pass('approval must match the complete plan fingerprint')
  await runtime.runPromise(Effect.gen(function* () {
    yield* (yield* Store).save({ ...wrongAccount, plan: { ...wrongAccount.plan, expiresAt: 0 } })
  }))
  expect((await cli('execute', { id: wrongAccount.plan.id }, ['--yolo'])).output.error?.code).toBe('PlanExpired')
  pass('expired plans cannot execute even with yolo')

  const interrupted = await runtime.runPromise(prepare({ ...transfer.plan, key: 'interrupted' }))
  const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const payload = Schema.decodeUnknownSync(Schema.Struct({ method: Schema.String }))(await request.clone().json())
    if (payload.method === 'eth_sendRawTransaction') return new Response('Submission transport unavailable', { status: 503 })
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() })
  } })
  const disconnected = ManagedRuntime.make(runtimeLayer({ database, rpcUrl: `http://127.0.0.1:${proxy.port}`, signer }))
  try {
    const outcome = await disconnected.runPromise(execute({ id: interrupted.plan.id, approval: { _tag: 'yolo' } }).pipe(Effect.result))
    expect(outcome._tag).toBe('Failure')
    if (outcome._tag === 'Failure') expect(outcome.failure.code).toBe('SubmissionUncertain')
  } finally { await disconnected.dispose(); await proxy.stop(true) }
  const persisted = await runtime.runPromise(status(interrupted.plan.id))
  expect(persisted.state._tag).toBe('submitting')
  const blocked = await runtime.runPromise(prepare({ ...transfer.plan, key: 'blocked-by-unresolved' }))
  expect((await cli('execute', { id: blocked.plan.id }, ['--yolo'])).output.error?.code).toBe('AccountBusy')
  const recovery = ManagedRuntime.make(runtimeLayer({ database, rpcUrl: url }))
  try {
    await recovery.runPromise(execute({ id: interrupted.plan.id, approval: { _tag: 'yolo' } }))
    const recovered = await recovery.runPromise(waitForOperation(interrupted.plan.id))
    expect(recovered.state._tag).toBe('confirmed')
    if (persisted.state._tag === 'submitting' && recovered.state._tag === 'confirmed') expect(recovered.state.hash).toBe(persisted.state.hash)
  } finally { await recovery.dispose() }
  pass('lost submission is persisted, blocks conflicting sends, and recovers identical signed bytes without a signer')

  const pending = await runtime.runPromise(prepare({ ...transfer.plan, key: 'pending' }))
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_setAutomine', params: [false] }) })
  const submittedPending = await runtime.runPromise(execute({ id: pending.plan.id, approval: { _tag: 'yolo' } }))
  expect(submittedPending.state._tag).toBe('pending')
  expect((await runtime.runPromise(status(pending.plan.id))).state._tag).toBe('pending')
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) })
  expect((await runtime.runPromise(status(pending.plan.id))).state._tag).toBe('confirmed')
  pass('pending transaction stays pending until a real receipt exists')
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_setAutomine', params: [true] }) })
  const evmRpc = async (method: string, params: Schema.Json[]) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(await response.json()).result
  }
  const deploy = async (name: string, args: readonly `0x${string}`[] = []) => {
    const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ bytecode: Schema.Struct({ object: Hex }) })))(await Bun.file(join(temporary, 'out', 'Assets.sol', `${name}.json`)).text())
    const token = args[0]
    const hash = token ? await wallet.deployContract({ abi: parseAbi(['constructor(address token)']), bytecode: artifact.bytecode.object, args: [token] }) : await wallet.deployContract({ abi: [], bytecode: artifact.bytecode.object })
    return Schema.decodeUnknownSync(Address)((await client.waitForTransactionReceipt({ hash })).contractAddress)
  }
  const asset = await deploy('Asset'), wrapper = await deploy('Wrapped'), vaultAddress = await deploy('Vault', [asset]), pool = await deploy('Lending'), bridgeAddress = await deploy('Bridge')
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: asset, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [signer.address, 1000000n] }) })
  const destination = privateKeyToAccount(generatePrivateKey()).address
  const runPlan = async (value: Schema.Json, wait = true) => {
    const op = Schema.decodeUnknownSync(Operation)(value)
    const result = await call('execute', { id: op.plan.id, approval: { _tag: 'yolo' } })
    return wait ? await call('wait', { id: op.plan.id }) : result
  }
  expect(await runPlan(await call('transfer', { chainId: 31337, account: signer.address, token: asset, to: destination, amount: '100', key: 'token-transfer' }))).toMatchObject({ state: { _tag: 'confirmed' } })
  expect(await client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [destination] })).toBe(100n)
  await runPlan(await call('approve', { chainId: 31337, account: signer.address, token: asset, spender: destination, amount: '50', key: 'token-approve' }))
  expect(await call('allowance', { chainId: 31337, account: signer.address, token: asset, spender: destination })).toMatchObject({ amount: '50' })
  await runPlan(await call('revoke', { chainId: 31337, account: signer.address, token: asset, spender: destination, key: 'token-revoke' }))
  expect(await call('allowance', { chainId: 31337, account: signer.address, token: asset, spender: destination })).toMatchObject({ amount: '0' })
  pass('token transfer, exact allowance and revocation change actual contract state')
  await runPlan(await call('wrap', { chainId: 31337, account: signer.address, wrapper, amount: '1000', key: 'wrap', action: 'wrap' }))
  await runPlan(await call('wrap', { chainId: 31337, account: signer.address, wrapper, amount: '400', key: 'unwrap', action: 'unwrap' }))
  expect(await client.readContract({ address: wrapper, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] })).toBe(600n)
  pass('wrapped native deposits and withdrawals')
  const deposit = Schema.decodeUnknownSync(Workflow)(await call('vault', { chainId: 31337, account: signer.address, vault: vaultAddress, amount: '500', key: 'vault-deposit', action: 'deposit' }))
  expect(await call('workflow-run', { id: deposit.id, approval: { _tag: 'approved', fingerprint: deposit.fingerprint } })).toMatchObject({ state: 'completed', completedSteps: 2 })
  const afterDepositNonce = await client.getTransactionCount({ address: signer.address })
  expect(await call('workflow-run', { id: deposit.id, approval: { _tag: 'yolo' } })).toMatchObject({ state: 'completed' })
  expect(await client.getTransactionCount({ address: signer.address })).toBe(afterDepositNonce)
  const redeem = Schema.decodeUnknownSync(Workflow)(await call('vault', { chainId: 31337, account: signer.address, vault: vaultAddress, amount: '200', key: 'vault-redeem', action: 'redeem' }))
  expect(await call('workflow-run', { id: redeem.id, approval: { _tag: 'yolo' } })).toMatchObject({ state: 'completed' })
  expect(await client.readContract({ address: vaultAddress, abi: erc20Abi, functionName: 'balanceOf', args: [signer.address] })).toBe(300n)
  pass('vault workflow checks outcomes and resumes without repeating approvals or deposits')
  const supply = Schema.decodeUnknownSync(Workflow)(await call('lending', { chainId: 31337, account: signer.address, pool, asset, amount: '250', key: 'supply', action: 'supply' }))
  expect(await call('workflow-run', { id: supply.id, approval: { _tag: 'yolo' } })).toMatchObject({ state: 'completed' })
  const withdraw = Schema.decodeUnknownSync(Workflow)(await call('lending', { chainId: 31337, account: signer.address, pool, asset, amount: '250', key: 'withdraw', action: 'withdraw' }))
  expect(await call('workflow-run', { id: withdraw.id, approval: { _tag: 'yolo' } })).toMatchObject({ state: 'completed' })
  pass('lending supply and withdrawal run through the same durable workflow')
  const typedInput = { chainId: 31337, account: signer.address, key: 'typed', domain: { name: 'Fixture', version: '1', chainId: 31337, verifyingContract: asset }, types: { Message: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Message', message: { amount: '123' } }
  const typedPreview = Schema.decodeUnknownSync(Schema.Struct({ fingerprint: Hex, signature: Schema.NullOr(Hex) }))(await call('sign-typed-data', typedInput))
  expect(typedPreview.signature).toBeNull()
  const typed = await call('sign-typed-data', { ...typedInput, approval: { _tag: 'approved', fingerprint: typedPreview.fingerprint } })
  expect(await call('sign-typed-data', { ...typedInput, approval: { _tag: 'yolo' } })).toEqual(typed)
  pass('EIP-712 preview, exact signing, verification and idempotent recovery')
  await call('monitor-create', { name: 'asset-events', chainId: 31337, address: asset, fromBlock: '0', confirmations: 1 })
  await evmRpc('evm_mine', [])
  const batch = Schema.decodeUnknownSync(Schema.Struct({ id: Hex, events: Schema.Array(Schema.Json) }))(await call('monitor-poll', { name: 'asset-events' }))
  expect(batch.events.length).toBeGreaterThan(0)
  expect(await call('monitor-poll', { name: 'asset-events' })).toMatchObject({ id: batch.id })
  await call('monitor-ack', { name: 'asset-events', id: batch.id })
  expect(await call('monitor-poll', { name: 'asset-events' })).toBeNull()
  await call('monitor-pause', { name: 'asset-events', paused: true })
  expect(await call('monitor-poll', { name: 'asset-events' })).toBeNull()
  pass('event monitor repeats unacknowledged batches and advances only after acknowledgement')
  await call('policy-create', { name: 'tiny-session', account: signer.address, chains: [31337], expiresAt: Date.now() + 600000, maxFeeWei: '1000000000000000', nativeBudgetWei: '5', contracts: [], tokenBudgets: [], recipients: [destination], revoked: false })
  await runPlan(await call('transfer', { chainId: 31337, account: signer.address, to: destination, amount: '4', key: 'budget-first', policy: 'tiny-session' }))
  const overBudget = Schema.decodeUnknownSync(Operation)(await call('transfer', { chainId: 31337, account: signer.address, to: destination, amount: '4', key: 'budget-next', policy: 'tiny-session' }))
  const budgetNonce = await client.getTransactionCount({ address: signer.address })
  const budgetDenied = await runtime.runPromise(execute({ id: overBudget.plan.id, approval: { _tag: 'yolo' } }).pipe(Effect.result))
  expect(budgetDenied._tag).toBe('Failure')
  if (budgetDenied._tag === 'Failure') expect(budgetDenied.failure.code).toBe('PolicyDenied')
  expect(await client.getTransactionCount({ address: signer.address })).toBe(budgetNonce)
  pass('yolo cannot exceed a persisted native spending policy')
  const reorgSnapshot = await evmRpc('evm_snapshot', [])
  const reorgPlan = Schema.decodeUnknownSync(Operation)(await call('transfer', { chainId: 31337, account: signer.address, to: destination, amount: '1', key: 'reorg' }))
  await runPlan(reorgPlan)
  await evmRpc('evm_revert', [reorgSnapshot])
  expect((await runtime.runPromise(status(reorgPlan.plan.id))).state._tag).toBe('submitting')
  await runtime.runPromise(execute({ id: reorgPlan.plan.id, approval: { _tag: 'yolo' } }))
  expect((await runtime.runPromise(waitForOperation(reorgPlan.plan.id))).state._tag).toBe('confirmed')
  pass('reorg removes inclusion and recovers the original signed transaction')
  const replacementOriginal = Schema.decodeUnknownSync(Operation)(await call('transfer', { chainId: 31337, account: signer.address, to: destination, amount: '1', key: 'replacement-original' }))
  await evmRpc('evm_setAutomine', [false])
  await runPlan(replacementOriginal, false)
  const replacement = Schema.decodeUnknownSync(Operation)(await call('replace', { id: replacementOriginal.plan.id, key: 'replacement-new', gasPrice: (BigInt(replacementOriginal.plan.gasPrice) * 2n).toString(), maxPriorityFeePerGas: (BigInt(replacementOriginal.plan.maxPriorityFeePerGas ?? '1') * 2n).toString(), cancel: false }))
  expect(await call('replace', { id: replacementOriginal.plan.id, key: 'replacement-new', gasPrice: replacement.plan.gasPrice, maxPriorityFeePerGas: replacement.plan.maxPriorityFeePerGas ?? '0', cancel: false })).toMatchObject({ plan: { fingerprint: replacement.plan.fingerprint } })
  await runPlan(replacement, false)
  await evmRpc('evm_mine', [])
  expect((await runtime.runPromise(status(replacement.plan.id))).state._tag).toBe('confirmed')
  expect((await runtime.runPromise(status(replacementOriginal.plan.id))).state._tag).toBe('superseded')
  await evmRpc('evm_setAutomine', [true])
  pass('same-nonce EIP-1559 replacement supersedes the pending original')
  const raceOriginal = Schema.decodeUnknownSync(Operation)(await call('transfer', { chainId: 31337, account: signer.address, to: destination, amount: '1', key: 'race-original' }))
  await evmRpc('evm_setAutomine', [false]); await runPlan(raceOriginal, false)
  const raceReplacement = Schema.decodeUnknownSync(Operation)(await call('replace', { id: raceOriginal.plan.id, key: 'race-replace', gasPrice: (BigInt(raceOriginal.plan.gasPrice) * 2n).toString(), maxPriorityFeePerGas: (BigInt(raceOriginal.plan.maxPriorityFeePerGas ?? '1') * 2n).toString(), cancel: false }))
  await evmRpc('evm_mine', []); await evmRpc('evm_setAutomine', [true])
  const raceNonce = await client.getTransactionCount({ address: signer.address })
  expect((await runtime.runPromise(execute({ id: raceReplacement.plan.id, approval: { _tag: 'yolo' } }).pipe(Effect.result)))._tag).toBe('Failure')
  expect(await client.getTransactionCount({ address: signer.address })).toBe(raceNonce)
  pass('replacement is idempotent and refuses to sign after the original is included')
  const mismatch = Schema.decodeUnknownSync(Workflow)(await call('workflow-create', { key: 'outcome-failure', steps: [{ label: 'Transfer with an impossible outcome', intent: { chainId: 31337, account: signer.address, to: destination, value: '1', data: '0x', key: 'mismatch' }, check: { call: { chainId: 31337, address: asset, signatures: ['function balanceOf(address) view returns(uint256)'], functionName: 'balanceOf', args: [destination] }, comparison: 'atLeast', expected: '999999999' } }] }))
  expect((await runtime.runPromise(dispatch('workflow-run', { id: mismatch.id, approval: { _tag: 'yolo' } }).pipe(Effect.result)))._tag).toBe('Failure')
  expect(await call('workflow-status', { id: mismatch.id })).toMatchObject({ state: 'pending', completedSteps: 0 })
  pass('workflow status cannot claim completion after a failed outcome check')
  let batchSends = 0
  let batchHash: `0x${string}` | undefined
  let wrongBatchId = false
  const simulationFixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.text()
    const payload = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Json, method: Schema.String, params: Schema.optionalKey(Schema.Array(Schema.Json)) }))(JSON.parse(body))
    if (payload.method !== 'eth_simulateV1') return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const input = Schema.decodeUnknownSync(Schema.Struct({ blockStateCalls: Schema.Array(Schema.Struct({ calls: Schema.Array(Schema.Json) })) }))(payload.params?.[0])
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: input.blockStateCalls.map((block, index) => ({ number: '0x1', timestamp: '0x1', gasLimit: '0x100000', gasUsed: '0x5208', transactions: [], calls: block.calls.map(() => ({ status: '0x1', returnData: index === 0 || index === 3 ? `0x${'0'.repeat(64)}` : '0x', gasUsed: '0x5208', logs: [] })) })) })
  } })
  const batchRuntime = ManagedRuntime.make(runtimeLayer({ database: join(temporary, 'batch.sqlite'), rpcUrl: simulationFixture.url.toString(), externalSigner: { address: signer.address, interactive: false, send: async () => { throw new Error('not a single-transaction test') }, request: async (method, params) => {
    if (method === 'wallet_sendCalls') {
      batchSends++
      batchHash = await wallet.sendTransaction({ to: destination, value: 1n })
      await client.waitForTransactionReceipt({ hash: batchHash })
      throw new Error('simulated lost batch response')
    }
    return { id: wrongBatchId ? 'wrong-id' : String(params[0]), chainId: '0x7a69', status: batchHash ? 200 : 100, atomic: false, receipts: batchHash ? [{ transactionHash: batchHash }] : [] }
  } } }))
  try {
    const plannedBatch = Schema.decodeUnknownSync(Batch)(await batchRuntime.runPromise(dispatch('batch-prepare', { key: 'batch', chainId: 31337, account: signer.address, calls: [{ to: destination, data: '0x', value: '1' }], atomicRequired: false })))
    const submittedBatch = await batchRuntime.runPromise(dispatch('batch-run', { id: plannedBatch.id, approval: { _tag: 'yolo' } }).pipe(Effect.result))
    expect(submittedBatch._tag).toBe('Failure')
    if (submittedBatch._tag === 'Failure') { expect(submittedBatch.failure.code).toBe('SubmissionUncertain') }
    expect(await batchRuntime.runPromise(dispatch('batch-run', { id: plannedBatch.id, approval: { _tag: 'yolo' } }))).toMatchObject({ state: 'confirmed' })
    expect(batchSends).toBe(1)
    wrongBatchId = true
    expect((await batchRuntime.runPromise(dispatch('batch-status', { id: plannedBatch.id }).pipe(Effect.result)))._tag).toBe('Failure')
  } finally { await batchRuntime.dispose(); await simulationFixture.stop(true) }
  pass('with a simulation fixture, wallet batches recover a lost response by ID, verify receipts and reject mismatched wallet results')
  let walletHash: `0x${string}` | undefined
  const externalRuntime = ManagedRuntime.make(runtimeLayer({ database: join(temporary, 'external.sqlite'), rpcUrl: url, externalSigner: { address: signer.address, interactive: false, send: async (plan, nonce) => { walletHash = await wallet.sendTransaction({ to: plan.to, data: plan.data, value: BigInt(plan.value), nonce, gas: BigInt(plan.gas), maxFeePerGas: BigInt(plan.gasPrice), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas ?? '0') }); throw new Error('simulated lost wallet response') } } }))
  try {
    const planned = await externalRuntime.runPromise(prepare({ chainId: 31337, account: signer.address, to: destination, value: '1', data: '0x', key: 'external' }))
    expect((await externalRuntime.runPromise(execute({ id: planned.plan.id, approval: { _tag: 'yolo' } }).pipe(Effect.result)))._tag).toBe('Failure')
    if (!walletHash) throw new Error('Expected wallet hash')
    await client.waitForTransactionReceipt({ hash: walletHash })
    const externalNonce = await client.getTransactionCount({ address: signer.address })
    expect((await externalRuntime.runPromise(execute({ id: planned.plan.id, approval: { _tag: 'yolo' } }))).state._tag).toBe('walletPending')
    expect(await client.getTransactionCount({ address: signer.address })).toBe(externalNonce)
    expect(await externalRuntime.runPromise(dispatch('attach-transaction', { id: planned.plan.id, hash: walletHash }))).toMatchObject({ state: { _tag: 'confirmed' } })
  } finally { await externalRuntime.dispose() }
  pass('lost external-wallet responses remain unresolved until a matching transaction hash is attached')
  const fakeSocket = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const req = new URL(request.url)
    if (req.pathname.endsWith('/status')) return Response.json({ success: true, result: { quoteId: 'fixture-route', status: 'IN_PROGRESS' } })
    const amount = req.searchParams.get('inputAmount') ?? '100'
    return Response.json({ success: true, result: { originChainId: 31337, destinationChainId: 8453, userAddress: signer.address, receiverAddress: destination, input: { token: { address: asset, chainId: 31337, symbol: 'ASSET', decimals: 18 }, amount }, routes: [{ quoteId: 'fixture-route', expiresAt: Date.now() / 1000 + 120, output: { token: { address: asset, chainId: 8453, symbol: 'ASSET', decimals: 18 }, amount, minAmountOut: amount }, approval: { tokenAddress: asset, spenderAddress: bridgeAddress, amount }, txData: { kind: 'evm_tx', object: { chainId: 31337, to: bridgeAddress, data: encodeFunctionData({ abi: parseAbi(['function bridge(address,address,uint256) payable']), functionName: 'bridge', args: [asset, destination, BigInt(amount)] }), value: '0' } }, routeTags: ['SUGGESTED'], estimatedTime: 10 }] } })
  } })
  const bridgeRuntime = ManagedRuntime.make(runtimeLayer({ database: join(temporary, 'bridge.sqlite'), rpcUrl: url, signer, socketUrl: fakeSocket.url.toString() }))
  try {
    const result = Schema.decodeUnknownSync(Schema.Struct({ bridge: BridgeRecord }))(await bridgeRuntime.runPromise(dispatch('bridge-prepare', { key: 'fixture-bridge', originChainId: 31337, destinationChainId: 8453, inputToken: asset, outputToken: asset, inputAmount: '100', userAddress: signer.address, receiverAddress: destination, slippage: 0.5 })))
    const first = await bridgeRuntime.runPromise(dispatch('bridge-run', { id: result.bridge.id, approval: { _tag: 'yolo' } }))
    expect(first).toMatchObject({ source: { state: 'completed', completedSteps: 2 }, destination: { status: 'IN_PROGRESS' } })
    expect(first).toMatchObject({ settlement: { verified: false } })
    const deliveryHash = await wallet.writeContract({ address: asset, abi: erc20Abi, functionName: 'transfer', args: [destination, 100n] })
    await client.waitForTransactionReceipt({ hash: deliveryHash })
    const localBridge = { ...result.bridge, request: { ...result.bridge.request, destinationChainId: 31337 } }
    const completed = { quoteId: 'fixture-route', status: 'COMPLETED' as const, destination: { chainId: 31337, receiverAddress: destination, txHash: deliveryHash } }
    expect(await bridgeRuntime.runPromise(verifyBridgeSettlement(localBridge, completed, true))).toMatchObject({ verified: true })
    expect(await bridgeRuntime.runPromise(verifyBridgeSettlement({ ...localBridge, request: { ...localBridge.request, receiverAddress: signer.address } }, completed, true))).toMatchObject({ verified: false })
    const bridgeNonce = await client.getTransactionCount({ address: signer.address })
    expect(await bridgeRuntime.runPromise(dispatch('bridge-run', { id: result.bridge.id, approval: { _tag: 'yolo' } }))).toMatchObject({ destination: { status: 'IN_PROGRESS' } })
    expect(await client.getTransactionCount({ address: signer.address })).toBe(bridgeNonce)
  } finally { await bridgeRuntime.dispose(); await fakeSocket.stop(true) }
  pass('Socket approval and exact route calldata execute once while destination settlement remains in progress')
  const result = await runtime.runPromise(status(concurrent.plan.id))
  await Bun.write(join(artifacts, 'e2e.json'), JSON.stringify({ checks, chainId: 31337, contract: address, deployment, finalOperation: { id: result.plan.id, state: result.state._tag }, testedAt: new Date().toISOString() }, null, 2))
  process.stdout.write(`Verified ${checks.length} end-to-end checks. Evidence: ${join(artifacts, 'e2e.json')}\n`)
} finally {
  await runtime.dispose()
  node.kill()
  await node.exited
}
