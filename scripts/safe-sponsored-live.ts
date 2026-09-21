import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, ManagedRuntime, Redacted, Schema, Schedule } from 'effect'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { dispatch } from '../src/catalog'
import { runtimeLayer } from '../src/runtime'
import { Signer } from '../src/execution'
import { SafeSponsoredRecord } from '../src/safe'

const path = process.env.SAFE_TEST_CONFIG
if (!path) throw new Error('Set SAFE_TEST_CONFIG to the private testnet configuration file.')
const config = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ apiKey: Schema.NonEmptyString, chainId: Schema.Literal(84532) })))(await Bun.file(path).text())
const signer = privateKeyToAccount(generatePrivateKey())
const second = privateKeyToAccount(generatePrivateKey())
const third = privateKeyToAccount(generatePrivateKey())
const directory = await mkdtemp(join(tmpdir(), 'safe-sponsored-live-'))
const url = Redacted.make(`https://api.pimlico.io/v2/84532/rpc?apikey=${encodeURIComponent(config.apiKey)}`)
const runtime = ManagedRuntime.make(runtimeLayer({ database: join(directory, 'journal.sqlite'), signer, rpcUrl: 'https://sepolia.base.org', safeRelay: { chainId: 84532, bundlerUrl: url, paymasterUrl: url } }))
const call = (name: string, input: Schema.Json) => runtime.runPromise(dispatch(name, input))
try {
  const proposal = { chainId: 84532, wallet: { owners: [signer.address, second.address, third.address], threshold: 2, saltNonce: BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`).toString() }, calls: [{ to: signer.address, value: '0', data: '0x' }], key: 'live-safe-sponsored' }
  const raw = await call('safe-sponsored-propose', proposal)
  if (JSON.stringify(raw) !== JSON.stringify(await call('safe-sponsored-propose', proposal))) throw new Error('Proposal is not idempotent')
  const prepared = Schema.decodeUnknownSync(SafeSponsoredRecord)(raw)
  console.log(JSON.stringify({ step: 'prepared', safe: prepared.safe, paymaster: prepared.userOperation.paymaster, chainId: 84532 }))
  const input = { id: prepared.id, fingerprint: prepared.fingerprint }
  await call('safe-sponsored-sign', input)
  async function reject(action: () => Promise<Schema.Json>) {
    try { await action() } catch { return }
    throw new Error('Expected operation rejection')
  }
  await reject(() => call('safe-sponsored-submit', input))
  await call('safe-sponsored-signature', { ...input, signature: { owner: second.address, data: `0x${'00'.repeat(65)}`, contract: false } })
  await reject(() => call('safe-sponsored-submit', input))
  if (Schema.decodeUnknownSync(SafeSponsoredRecord)(await call('safe-sponsored-status', { id: input.id })).state !== 'prepared') throw new Error('Invalid signature consumed the editable operation')
  await runtime.runPromise(dispatch('safe-sponsored-sign', input).pipe(Effect.provideService(Signer, Signer.of({ account: second }))))
  await reject(() => call('safe-sponsored-submit', { ...input, fingerprint: `0x${'00'.repeat(32)}` }))
  await call('safe-sponsored-submit', input)
  const final = await Effect.runPromise(Effect.tryPromise(async () => {
    const record = Schema.decodeUnknownSync(SafeSponsoredRecord)(await call('safe-sponsored-status', { id: input.id }))
    if (record.state === 'pending') throw new Error('pending')
    if (record.state !== 'confirmed') throw new Error(`Unexpected state ${record.state}`)
    return record
  }).pipe(Effect.retry({ times: 30, schedule: Schedule.spaced('2 seconds') })))
  if (Schema.decodeUnknownSync(SafeSponsoredRecord)(await call('safe-sponsored-submit', input)).transactionHash !== final.transactionHash) throw new Error('Confirmed operation was resubmitted')
  const evidence = { chainId: 84532, safe: final.safe, userOperationHash: final.userOperationHash, transactionHash: final.transactionHash, state: final.state, value: '0', ephemeralOwners: [signer.address, second.address, third.address], threshold: 2, checks: ['idempotent proposal', 'insufficient quorum rejected', 'invalid signature remains editable', 'wrong fingerprint rejected', 'duplicate submit returns receipt'], userFundsUsed: false }
  console.log(JSON.stringify(evidence, null, 2))
  await Bun.write(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
} finally { await runtime.dispose() }
