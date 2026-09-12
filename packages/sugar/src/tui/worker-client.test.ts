import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult, toFunctionSelector, toHex } from 'viem'
import { abis } from '../abis'
import { toSugarJson } from '../helpers'
import { jsonRecord } from './format'
import { TuiWorkerClient } from './worker-client'

const countSelector = toFunctionSelector('count()')
const countResult = encodeFunctionResult({ abi: abis.sugar, functionName: 'count', result: 0n })
const poolsResult = encodeFunctionResult({ abi: abis.sugar, functionName: 'forSwaps', result: [] })

function fixture(options: { tokenResult?: string; wait?: Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-worker-'))
  let counts = 0
  let reads = 0
  let worker: Worker | undefined
  const requested = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = jsonRecord(toSugarJson(await request.json()))
      const params = body?.params
      const call = Array.isArray(params) ? jsonRecord(params[0] ?? null) : undefined
      requested.resolve()
      await options.wait
      const count = call?.data === countSelector
      if (count) counts += 1
      return Response.json({ jsonrpc: '2.0', id: body?.id, result: count ? countResult : options.tokenResult ?? poolsResult })
    },
  })
  const client = new TuiWorkerClient(() => {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      env: { ...process.env, SUGAR_RPC_URI_8453: server.url.href, AERO_CACHE_DIR: directory },
    })
    return worker
  }, () => { reads += 1 })
  return {
    client,
    requested: requested.promise,
    counts: () => counts,
    reads: () => reads,
    crash: () => worker?.terminate(),
    close: () => {
      client.stop()
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

test('worker reads share caches, publish RPC progress, and refresh from the RPC', async () => {
  const session = fixture()
  try {
    const task = { kind: 'action', action: 'pools', parameters: { chain: 8453 } } as const
    const [first, second] = await Promise.all([session.client.request(task).promise, session.client.request(task).promise])
    expect(first).toEqual({ kind: 'action', data: [] })
    expect(second).toEqual(first)
    expect(session.counts()).toBe(1)
    expect(session.reads()).toBeGreaterThan(0)
    await session.client.request({ ...task, fresh: true }).promise
    expect(session.counts()).toBe(2)
  } finally {
    session.close()
  }
})

test('the UI event loop keeps ticking while the real worker decodes a large token catalog', async () => {
  const raw = Array.from({ length: 10_000 }, (_, index) => [toHex(index + 100, { size: 20 }), `T${index}`, 18, 0n, true, false])
  const tokenResult = encodeFunctionResult({ abi: abis.sugar, functionName: 'tokens', result: raw })
  const session = fixture({ tokenResult })
  const gaps: number[] = []
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - previous)
    previous = now
  }, 16)
  try {
    const result = await session.client.request({ kind: 'tokens', chain: 8453 }).promise
    expect(result.kind).toBe('tokens')
    if (result.kind !== 'tokens') throw new Error('Missing token catalog')
    expect(result.data).toHaveLength(10_001)
    expect(gaps.length).toBeGreaterThan(5)
    expect(Math.max(...gaps)).toBeLessThan(100)
  } finally {
    clearInterval(timer)
    session.close()
  }
}, 15_000)

test('cancelled subscriptions stop delivering updates and leave shared reads usable', async () => {
  const gate = Promise.withResolvers<void>()
  const session = fixture({ wait: gate.promise })
  let updates = 0
  try {
    const pending = session.client.request({ kind: 'subscribe', action: 'pools', parameters: { chain: 8453 } }, () => { updates += 1 })
    const rejected = pending.promise.catch((error: Error) => error.message)
    await session.requested
    pending.cancel()
    expect(await rejected).toContain('cancelled')
    gate.resolve()
    const result = await session.client.request({ kind: 'action', action: 'pools', parameters: { chain: 8453 } }).promise
    expect(result).toEqual({ kind: 'action', data: [] })
    expect(updates).toBe(0)
    expect(session.counts()).toBe(1)
  } finally {
    gate.resolve()
    session.close()
  }
})

test('a terminated worker rejects pending work and the next request starts a new worker', async () => {
  const gate = Promise.withResolvers<void>()
  const session = fixture({ wait: gate.promise })
  try {
    const pending = session.client.request({ kind: 'action', action: 'pools', parameters: { chain: 8453 } }).promise
    const rejected = pending.catch((error: Error) => error.message)
    await session.requested
    session.crash()
    expect(await rejected).toContain('worker stopped')
    gate.resolve()
    expect(await session.client.request({ kind: 'clear' }).promise).toEqual({ kind: 'done' })
    expect(await session.client.request({ kind: 'action', action: 'pools', parameters: { chain: 8453 } }).promise)
      .toEqual({ kind: 'action', data: [] })
  } finally {
    gate.resolve()
    session.close()
  }
})

test('worker startup errors reject requests instead of leaving a loading screen stuck', async () => {
  const client = new TuiWorkerClient(() => new Worker(new URL('./missing-worker.ts', import.meta.url)))
  try {
    await expect(client.request({ kind: 'clear' }).promise).rejects.toBeInstanceOf(Error)
  } finally {
    client.stop()
  }
})
