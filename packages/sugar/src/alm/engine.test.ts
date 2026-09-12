import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, custom, type Address, type Hex, type TransactionReceipt } from 'viem'
import { SugarClient } from '../client'
import { createFileJournalStore } from '../execution-journal'
import { ADDRESS_ZERO, type Position, type Token, type UnsignedTransaction } from '../types'
import { stubPublicClient } from '../test-support'
import { parseAlmConfig } from './config'
import { AlmEngine } from './engine'
import { encodeRoleConfigCall, encodeRoleKey } from './roles'
import { acquireAlmStateLock, loadAlmState, positionStateKey } from './state'

const wallet: Address = '0x1000000000000000000000000000000000000001'
const poolAddress: Address = '0x2000000000000000000000000000000000000002'
const token = (address: string, symbol: string): Token => ({ chainId: 8453, chainName: 'Base', tokenAddress: address, symbol, decimals: 18, listed: true, emerging: false })
const token0 = token('0x3000000000000000000000000000000000000003', 'A')
const token1 = token('0x4000000000000000000000000000000000000004', 'B')
const emissionsToken = token('0x5000000000000000000000000000000000000005', 'AERO')
const hash: Hex = `0x${'1'.repeat(64)}`
const receipt: TransactionReceipt = {
  transactionHash: hash, transactionIndex: 0, blockHash: hash, blockNumber: 1n, from: wallet, to: poolAddress,
  cumulativeGasUsed: 1n, gasUsed: 1n, contractAddress: null, logs: [], logsBloom: '0x', status: 'success',
  effectiveGasPrice: 1n, type: 'eip1559',
}
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aero-alm-test-'))
  directories.push(directory)
  const statePath = join(directory, 'state.json')
  const store = createFileJournalStore(join(directory, 'executions'))
  let current: Position | undefined = {
    chainId: 8453, chainName: 'Base', id: 42n, liquidity: 1_000n, staked: 0n,
    amountToken0: 1_000n, amountToken1: 1_000n, stakedToken0: 0n, stakedToken1: 0n,
    unstakedEarned0: 0n, unstakedEarned1: 0n, emissionsEarned: 2n * 10n ** 18n,
    tickLower: -1_000, tickUpper: 1_000, sqrtRatioLower: 1n, sqrtRatioUpper: 1n,
    alm: ADDRESS_ZERO, isCl: true, isAlm: false, isInRange: true,
    pool: {
      chainId: 8453, chainName: 'Base', lp: poolAddress, factory: poolAddress, symbol: 'A/B', type: 100,
      isStable: false, isCl: true, tick: 2_000, sqrtRatio: 1n, totalSupply: 1_000n, decimals: 18,
      token0, token1, poolFee: 1n, gauge: poolAddress, gaugeAlive: false, gaugeTotalSupply: 1n,
      nfpm: poolAddress, alm: ADDRESS_ZERO, tvl: 1, totalFees: 0, volume: 0, token0Volume: 0, token1Volume: 0, apr: 0,
      emissionsToken,
    },
  }
  const publicClient = createPublicClient({ transport: custom({ request: async () => { throw new Error('Unexpected live RPC call') } }) })
  let spot = 2_000
  let twap: number | undefined = 2_000
  const read = spyOn(publicClient, 'readContract').mockImplementation(stubPublicClient({ readContract: async ({ functionName }) => {
    if (functionName === 'slot0') return [1n, spot]
    if (functionName === 'observe') {
      if (twap === undefined) throw new Error('OLD')
      return [[0n, BigInt(twap) * 300n], [0n, 0n]]
    }
    throw new Error(`Unexpected read ${functionName}`)
  } }).readContract)
  spyOn(publicClient, 'getChainId').mockResolvedValue(8453)
  const simulate = spyOn(publicClient, 'simulateCalls').mockRejectedValue(new Error('method not supported'))
  const wait = spyOn(publicClient, 'waitForTransactionReceipt').mockResolvedValue(receipt)
  const reconcile = spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue(receipt)
  const client = new SugarClient(8453, { account: wallet, publicClient })
  const poolRead = spyOn(client, 'getPositionByPool').mockImplementation(async () => current)
  spyOn(client, 'getPositionsByPool').mockImplementation(async () => current ? [current] : [])
  const idRead = spyOn(client, 'getPositionById').mockImplementation(async (id) => current?.id === id ? current : undefined)
  spyOn(client, 'balanceOf').mockResolvedValue(0n)
  const transaction: UnsignedTransaction = { from: wallet, to: poolAddress, data: '0x', value: 0n }
  const withdraw = spyOn(client, 'withdraw').mockResolvedValue([transaction])
  const claim = spyOn(client, 'claimEmissions').mockResolvedValue([transaction])
  spyOn(client, 'unstake').mockResolvedValue([transaction])
  let sends = 0
  const signer = { address: wallet, describe: 'offline test', send: async (): Promise<Hex> => { sends++; return hash } }
  const logs: string[] = []
  const config = parseAlmConfig({ version: 1, positions: [{ pool: poolAddress }] })
  const options = { config, wallet, signer, publicClient, clientFactory: () => client, statePath, journalStore: store, requireSimulation: false, log: (line: string) => logs.push(line) }
  return {
    options, client, store, statePath, logs, read, wait, reconcile, simulate, poolRead, idRead, withdraw, claim,
    setTick: (tick: number, average: number | undefined) => { spot = tick; twap = average },
    setStaked: () => { if (current) current = { ...current, staked: 1_000n } },
    disappear: () => { current = undefined },
    mint: (tickLower: number, tickUpper: number) => { if (current) current = { ...current, id: 43n, tickLower, tickUpper } },
    sends: () => sends,
    state: () => loadAlmState(statePath)[positionStateKey(8453, poolAddress, wallet)],
  }
}

describe('ALM execution safety', () => {
  test('blocks Safe execution and permission encoding before any RPC or signing', () => {
    const f = fixture()
    const safe = { rolesModifier: poolAddress, roleKey: encodeRoleKey('aero-alm') }
    expect(() => new AlmEngine({ ...f.options, safe })).toThrow('disabled for 0.1')
    expect(() => new AlmEngine({ ...f.options, config: { ...f.options.config, safe: { ...safe, address: wallet } } })).toThrow('disabled for 0.1')
    expect(() => encodeRoleConfigCall(poolAddress, { functionName: 'scopeTarget', args: [] })).toThrow('disabled for 0.1')
    expect(f.read).not.toHaveBeenCalled()
    expect(f.sends()).toBe(0)
  })

  test('blocks compounding on a divergent or missing TWAP before claiming', async () => {
    for (const average of [1_000, undefined]) {
      const f = fixture()
      f.setStaked()
      f.setTick(0, average)
      await new AlmEngine(f.options).runPass()
      expect(f.read.mock.calls.some(([request]) => request.functionName === 'observe')).toBe(true)
      expect(f.claim).not.toHaveBeenCalled()
      expect(f.sends()).toBe(0)
    }
  })

  test('journals a submitted withdrawal and never restarts it after a receipt timeout', async () => {
    const f = fixture()
    f.wait.mockRejectedValue(new Error('timeout'))
    await new AlmEngine(f.options).runPass()
    expect(f.sends()).toBe(1)
    const cycle = f.state().cycle
    expect(cycle).toMatchObject({ kind: 'rebalance', positionId: '42', status: { kind: 'active' }, balances: { token0: '0', token1: '0' } })
    expect(cycle?.phases[0].name).toBe('withdraw')
    expect(f.state().rebalances).toHaveLength(1)
    f.disappear()
    await new AlmEngine(f.options).runPass()
    expect(f.reconcile).toHaveBeenCalledTimes(1)
    expect(f.sends()).toBe(1)
    expect(f.withdraw).toHaveBeenCalledTimes(1)
    expect(f.store.list()[0].steps).toEqual([{ kind: 'confirmed', hash }])
    expect(f.state().cycle?.status.kind).toBe('active')
    expect(f.logs.some((line) => line.includes('manual recovery'))).toBe(true)
  })

  test('halts after a confirmed withdrawal if the next manipulation check fails', async () => {
    const f = fixture()
    f.wait.mockImplementation(async () => { f.setTick(10_000, 2_000); f.disappear(); return receipt })
    const engine = new AlmEngine(f.options)
    await engine.runPass()
    expect(f.sends()).toBe(1)
    expect(f.state().cycle?.status.kind).toBe('active')
    await engine.runPass()
    expect(f.sends()).toBe(1)
    expect(f.poolRead).toHaveBeenCalledTimes(1)
  })

  test('journals compounding and refuses to repeat a claim after interruption', async () => {
    const f = fixture()
    f.setStaked()
    f.setTick(0, 0)
    f.wait.mockRejectedValue(new Error('receipt unavailable'))
    await new AlmEngine(f.options).runPass()
    expect(f.state().cycle).toMatchObject({ kind: 'compound', positionId: '42', status: { kind: 'active' } })
    expect(f.state().lastCompoundAt).toBeGreaterThan(0)
    await new AlmEngine(f.options).runPass()
    expect(f.claim).toHaveBeenCalledTimes(1)
    expect(f.sends()).toBe(1)
  })

  test('aborts before sending when simulation fails', async () => {
    const f = fixture()
    f.simulate.mockRejectedValue(new Error('execution reverted'))
    await new AlmEngine(f.options).runPass()
    expect(f.sends()).toBe(0)
    expect(f.state().cycle?.status.kind).toBe('active')
  })

  test('completes a fresh rebalance and records the replacement NFT without double-counting attempts', async () => {
    const f = fixture()
    f.options.config.positions[0].positionId = 42n
    const original = await f.client.getPositionByPool(poolAddress)
    if (!original) throw new Error('Missing test position')
    spyOn(f.client, 'balanceOf').mockImplementation(async () => f.sends() > 0 ? 1_000n : 0n)
    spyOn(f.client, 'getPoolByAddress').mockResolvedValue(original.pool)
    spyOn(f.client, 'quoteConcentratedDeposit').mockImplementation(async (pool, input) => ({ pool, ...input, amountToken0: 1_000n, amountToken1: 1_000n, sqrtPriceX96: 1n }))
    spyOn(f.client, 'deposit').mockImplementation(async (quote) => {
      if (quote.tickLower === undefined || quote.tickUpper === undefined) throw new Error('Missing test interval')
      f.mint(quote.tickLower, quote.tickUpper)
      return [{ from: wallet, to: poolAddress, value: 0n, data: '0x' }]
    })
    await new AlmEngine(f.options).runPass()
    expect(f.logs.filter((line) => line.includes('failed') || line.includes('blocked'))).toEqual([])
    expect(f.sends()).toBe(2)
    expect(f.state().cycle).toMatchObject({ status: { kind: 'complete' }, positionId: '42', resultPositionId: '43' })
    expect(f.state().rebalances).toHaveLength(1)
    expect(f.store.list().every((entry) => entry.status === 'complete')).toBe(true)
    expect(f.state().managedPositionId).toBe('43')
    expect(f.state().configuredPositionId).toBe('42')
    f.setTick(2_000, 2_000)
    f.idRead.mockClear()
    await new AlmEngine(f.options).runPass()
    expect(f.idRead).toHaveBeenCalledWith(43n, wallet, poolAddress)
  })

  test('uses the configured NFT when pool-only lookup is ambiguous', async () => {
    const f = fixture()
    f.options.config.positions[0].positionId = 42n
    f.poolRead.mockRejectedValue(new Error('multiple positions'))
    f.setTick(0, 0)
    await new AlmEngine({ ...f.options, signer: undefined }).runPass()
    expect(f.poolRead).not.toHaveBeenCalled()
    expect(f.idRead).toHaveBeenCalledWith(42n, wallet, poolAddress)
    expect(f.logs.some((line) => line.includes('failed'))).toBe(false)
  })

  test('rechecks the guard after approvals and leaves an unsubmitted action recoverable', async () => {
    const f = fixture()
    const transaction: UnsignedTransaction = { from: wallet, to: poolAddress, data: '0x', value: 0n }
    f.withdraw.mockResolvedValue([transaction, transaction])
    f.wait.mockImplementation(async () => { f.setTick(10_000, 2_000); return receipt })
    await new AlmEngine(f.options).runPass()
    expect(f.sends()).toBe(1)
    expect(f.store.list()[0].steps).toEqual([{ kind: 'confirmed', hash }, { kind: 'ready' }])
    expect(f.state().cycle?.status.kind).toBe('active')
  })

  test('serializes overlapping engines and preserves the interrupted attempt', async () => {
    const f = fixture()
    const first = new AlmEngine(f.options)
    const second = new AlmEngine(f.options)
    const release = acquireAlmStateLock(f.statePath)
    await second.runPass()
    release()
    expect(f.sends()).toBe(0)
    expect(f.logs.some((line) => line.includes('locked'))).toBe(true)
    f.wait.mockRejectedValue(new Error('timeout'))
    await Promise.all([first.runPass(), second.runPass()])
    expect(f.sends()).toBe(1)
    expect(f.state().rebalances).toHaveLength(1)
  })
})
