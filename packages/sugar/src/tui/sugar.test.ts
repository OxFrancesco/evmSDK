import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SugarClient } from '../client'
import { clearTuiPrefetch, runTuiAction, tuiExecution } from './sugar-runtime'
import { stubPublicClient, stubSugarClient } from '../test-support'
import type { Token } from '../types'

let directory: string
let previousDirectory: string | undefined
beforeEach(() => {
  previousDirectory = process.env.AERO_CACHE_DIR
  directory = mkdtempSync(join(tmpdir(), 'aero-requests-'))
  process.env.AERO_CACHE_DIR = directory
})

test('identical quote requests read a new market price', async () => {
  const from: Token = { chainId: 8453, chainName: 'Base', tokenAddress: 'ETH', symbol: 'ETH', decimals: 18, listed: false, emerging: false }
  const to: Token = { ...from, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }
  let quotes = 0
  const previousFactory = tuiExecution.clientFactory
  tuiExecution.clientFactory = () => stubSugarClient({
    getToken: async (reference) => reference === 'ETH' ? from : to,
    getPrices: async () => [],
    getQuote: async (_from, _to, amountIn) => ({
      input: { fromToken: from, toToken: to, amountIn, path: [] },
      amountOut: BigInt(++quotes),
    }),
  })
  try {
    const parameters = { chain: 8453, from_token: 'ETH', to_token: to.tokenAddress, amount: '1' }
    const first = await runTuiAction('quote', parameters)
    const second = await runTuiAction('quote', parameters)
    expect(second).not.toEqual(first)
    expect(quotes).toBe(2)
  } finally {
    tuiExecution.clientFactory = previousFactory
  }
})

test('explicit refresh bypasses the shared SDK pool cache', async () => {
  let counts = 0
  const previousClient = tuiExecution.publicClient
  tuiExecution.publicClient = stubPublicClient({
    readContract: async ({ functionName }) => {
      if (functionName === 'count') { counts += 1; return 0n }
      if (functionName === 'forSwaps') return []
      throw new Error(`Unexpected read ${functionName}`)
    },
  })
  try {
    await runTuiAction('pools', { chain: 8453 })
    await runTuiAction('pools', { chain: 8453 }, { fresh: true })
    expect(counts).toBe(2)
  } finally {
    tuiExecution.publicClient = previousClient
  }
})
afterEach(async () => {
  await clearTuiPrefetch()
  if (previousDirectory === undefined) delete process.env.AERO_CACHE_DIR
  else process.env.AERO_CACHE_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

test('repeated refreshes share a pending scan even after its TTL has elapsed', async () => {
  const pending = Promise.withResolvers<[]>()
  const pools = spyOn(SugarClient.prototype, 'getPools').mockImplementation(() => pending.promise)
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  try {
    const first = runTuiAction('pools', { chain: 8453, full: true })
    clock.mockReturnValue(now + 61_000)
    const second = runTuiAction('pools', { chain: 8453, full: true }, { fresh: true })
    pending.resolve([])
    await Promise.all([first, second])
    expect(pools).toHaveBeenCalledTimes(1)
  } finally {
    pending.resolve([])
    pools.mockRestore()
    clock.mockRestore()
  }
})

test('an obsolete failed request cannot evict a newer successful refresh', async () => {
  const pending = Promise.withResolvers<[]>()
  const pools = spyOn(SugarClient.prototype, 'getPools')
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue([])
  try {
    const first = runTuiAction('pools', { chain: 8453, full: true }).catch(() => undefined)
    await clearTuiPrefetch()
    await runTuiAction('pools', { chain: 8453, full: true })
    pending.reject(new Error('old scan failed'))
    await first
    await runTuiAction('pools', { chain: 8453, full: true })
    expect(pools).toHaveBeenCalledTimes(2)
  } finally {
    pending.resolve([])
    pools.mockRestore()
  }
})
