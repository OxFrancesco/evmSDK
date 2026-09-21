import { expect } from 'bun:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { Effect, ManagedRuntime, Schema, Schedule } from 'effect'
import { concatHex, createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, padHex, parseAbi, parseEther, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import safeArtifact from '@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json'
import l2Artifact from '@safe-global/safe-contracts/build/artifacts/contracts/SafeL2.sol/SafeL2.json'
import factoryArtifact from '@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json'
import { dispatch } from '../src/catalog'
import { Address, Hex, Operation } from '../src/model'
import { runtimeLayer } from '../src/runtime'
import { SafeDeployment, SafeTransaction } from '../src/safe'
import { safeAbi } from '../src/safe/contracts'

const root = resolve(import.meta.dir, '..')
const temporary = await mkdtemp(join(tmpdir(), 'evm-safe-e2e-'))
const reservation = createServer()
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
const bound = reservation.address()
if (!bound || Schema.is(Schema.String)(bound)) throw new Error('Cannot reserve test port')
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
const url = `http://127.0.0.1:${bound.port}`
const node = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(bound.port), '--silent'], { stdout: 'ignore', stderr: 'pipe' })
const signers = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())]
const [signer] = signers
if (!signer) throw new Error('Missing local signer')
const client = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0 }) })
const wallet = createWalletClient({ chain: anvil, account: signer, transport: http(url) })
const runtime = ManagedRuntime.make(runtimeLayer({ database: join(temporary, 'operations.sqlite'), rpcUrl: url, signer }))
const call = (name: string, input: Schema.Json) => runtime.runPromise(dispatch(name, input))
const checks: string[] = []
const pass = (name: string) => { checks.push(name); process.stdout.write(`PASS ${name}\n`) }
const set = async (method: string, params: ReadonlyArray<string>) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const result = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optionalKey(Schema.Json) }))(await response.json())
  if (!response.ok || result.error !== undefined) throw new Error(`Local RPC ${method} failed`)
}
const runPlan = async (raw: Schema.Json) => {
  const operation = Schema.decodeUnknownSync(Operation)(raw)
  await call('execute', { id: operation.plan.id, approval: { _tag: 'approved', fingerprint: operation.plan.fingerprint } })
  const result = await call('wait', { id: operation.plan.id })
  expect(result).toMatchObject({ state: { _tag: 'confirmed' } })
  return operation
}

try {
  await Effect.runPromise(Effect.tryPromise(() => client.getChainId()).pipe(Effect.retry({ times: 30, schedule: Schedule.spaced('100 millis') })))
  await set('anvil_setBalance', [signer.address, `0x${parseEther('10').toString(16)}`])
  for (const [address, artifact] of [['0x41675C099F32341bf84BFc5382aF534df5C7461a', safeArtifact], ['0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', l2Artifact], ['0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', factoryArtifact]] as const) {
    await set('anvil_setCode', [address, artifact.deployedBytecode])
  }
  const compile = Bun.spawn(['forge', 'build', '--root', join(root, 'fixtures'), '--out', join(temporary, 'out'), '--cache-path', join(temporary, 'cache')], { stdout: 'ignore', stderr: 'pipe' })
  if (await compile.exited !== 0) throw new Error(await new Response(compile.stderr).text())
  const artifact = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ bytecode: Schema.Struct({ object: Hex }) })))(await Bun.file(join(temporary, 'out', 'OwnerWallet.sol', 'OwnerWallet.json')).text())
  const owners: `0x${string}`[] = []
  for (const controller of signers) {
    const tx = await wallet.deployContract({ abi: parseAbi(['constructor(address owner)']), bytecode: artifact.bytecode.object, args: [controller.address] })
    const receipt = await client.waitForTransactionReceipt({ hash: tx })
    owners.push(getAddress(Schema.decodeUnknownSync(Address)(receipt.contractAddress)))
    await set('anvil_setBalance', [controller.address, `0x${parseEther('1').toString(16)}`])
  }
  const create = { chainId: 31337, owners, threshold: 2, saltNonce: '123456' }
  await expect(call('safe-predict', { ...create, owners: [owners[0] ?? zeroAddress, owners[0] ?? zeroAddress] })).rejects.toThrow('distinct owners')
  await expect(call('safe-predict', { ...create, threshold: 4 })).rejects.toThrow('Threshold')
  await expect(call('safe-predict', { ...create, saltNonce: (2n ** 256n).toString() })).rejects.toThrow('uint256')
  const prediction = Schema.decodeUnknownSync(SafeDeployment)(await call('safe-predict', create))
  expect(prediction.deployed).toBe(false)
  const deploy = await runPlan(await call('safe-deploy', { ...create, account: signer.address, key: 'safe-deploy' }))
  expect(await call('safe-deploy', { ...create, account: signer.address, key: 'safe-deploy' })).toMatchObject({ plan: { id: deploy.plan.id }, state: { _tag: 'confirmed' } })
  const target = { chainId: 31337, safe: prediction.safe }
  expect(await call('safe-info', target)).toMatchObject({ owners, threshold: 2, nonce: '0', version: '1.4.1' })
  expect(await call('safe-predict', create)).toMatchObject({ safe: prediction.safe, deployed: true })
  pass('deterministic deployment, owner validation and idempotent deployment retry')
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: prediction.safe, value: 10n }) })
  const recipient = privateKeyToAccount(generatePrivateKey()).address
  const transaction = Schema.decodeUnknownSync(SafeTransaction)(await call('safe-propose', { ...target, to: recipient, value: '1', data: '0x' }))
  await expect(call('safe-approvals', { chainId: 31337, transaction: { ...transaction, value: '2' } })).rejects.toThrow('hash')
  await expect(call('safe-approvals', { chainId: 8453, transaction })).rejects.toThrow('chain')
  await expect(call('safe-approve', { chainId: 31337, transaction, account: signer.address, key: 'outsider' })).rejects.toThrow('not a Safe owner')
  const approve = async (index: number, proposal: SafeTransaction) => {
    const owner = owners[index]
    const controller = signers[index]
    if (!owner || !controller) throw new Error('Missing local owner')
    const prepared = Schema.decodeUnknownSync(Operation)(await call('safe-approve', { chainId: 31337, transaction: proposal, account: owner, key: `approval-${proposal.nonce}-${proposal.hash}-${index}` }))
    const controllerWallet = createWalletClient({ chain: anvil, account: controller, transport: http(url) })
    const hash = await controllerWallet.writeContract({ address: owner, abi: parseAbi(['function forward(address target,bytes data)']), functionName: 'forward', args: [proposal.safe, prepared.plan.data] })
    const receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')
  }
  await approve(0, transaction)
  expect(await call('safe-approvals', { chainId: 31337, transaction })).toMatchObject({ ready: false, threshold: 2 })
  await expect(call('safe-execute', { chainId: 31337, transaction, account: signer.address, key: 'too-early' })).rejects.toThrow('requires 2')
  const oneSignature = concatHex([padHex(owners[0] ?? zeroAddress, { size: 32 }), padHex('0x', { size: 32 }), '0x01'])
  await expect(client.call({ account: signer.address, to: prediction.safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [recipient, 1n, '0x', 0, 0n, 0n, 0n, zeroAddress, zeroAddress, oneSignature] }) })).rejects.toThrow()
  expect(await client.getBalance({ address: recipient })).toBe(0n)
  pass('contract-owner approval, tamper rejection and on-chain rejection with one owner')
  await approve(1, transaction)
  expect(await call('safe-approvals', { chainId: 31337, transaction })).toMatchObject({ ready: true })
  const execution = await runPlan(await call('safe-execute', { chainId: 31337, transaction, account: signer.address, key: 'execute-safe' }))
  expect(await client.getBalance({ address: recipient })).toBe(1n)
  await call('execute', { id: execution.plan.id, approval: { _tag: 'approved', fingerprint: execution.plan.fingerprint } })
  expect(await client.getBalance({ address: recipient })).toBe(1n)
  await expect(call('safe-execute', { chainId: 31337, transaction, account: signer.address, key: 'replay' })).rejects.toThrow('nonce')
  pass('two independently controlled contract owners execute once; replay rejected')
  const cancelled = Schema.decodeUnknownSync(SafeTransaction)(await call('safe-cancel-propose', target))
  const competing = Schema.decodeUnknownSync(SafeTransaction)(await call('safe-propose', { ...target, to: recipient, value: '2', data: '0x' }))
  await approve(0, cancelled); await approve(1, cancelled)
  await runPlan(await call('safe-execute', { chainId: 31337, transaction: cancelled, account: signer.address, key: 'cancel-safe' }))
  await expect(call('safe-approve', { chainId: 31337, transaction: competing, account: owners[0] ?? zeroAddress, key: 'stale' })).rejects.toThrow('nonce')
  pass('threshold-approved cancellation consumes the nonce and invalidates competitors')
  const remove = Schema.decodeUnknownSync(SafeTransaction)(await call('safe-owner-propose', { ...target, change: { kind: 'remove', owner: owners[2] ?? zeroAddress, threshold: 2 } }))
  await approve(0, remove); await approve(1, remove)
  await runPlan(await call('safe-execute', { chainId: 31337, transaction: remove, account: signer.address, key: 'remove-owner' }))
  expect(await call('safe-info', target)).toMatchObject({ owners: owners.slice(0, 2), threshold: 2, nonce: '3' })
  pass('owner removal requires the existing threshold and preserves remaining owners')
  const child = Bun.spawn([process.execPath, join(root, 'dist', 'cli.js'), 'safe-info', '--input', JSON.stringify(target)], { env: { ...process.env, EVM_RPC_URL: url, EVM_DATABASE: join(temporary, 'cli.sqlite'), EVM_PRIVATE_KEY: undefined }, stdout: 'pipe', stderr: 'pipe' })
  const cliOutput = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(JSON.parse(cliOutput)).toMatchObject({ ok: true, result: { safe: prediction.safe, threshold: 2 } })
  pass('built CLI exposes the same Safe state without a signing key')
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await Bun.write(join(root, 'artifacts', 'safe-e2e.json'), JSON.stringify({ network: 'isolated Anvil', safe: prediction.safe, owners, checks, privateKeys: 'ephemeral; not recorded', crossmintLiveSigning: false }, null, 2))
} finally {
  await runtime.dispose()
  node.kill()
  await node.exited
}
