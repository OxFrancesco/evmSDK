import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, encodeAbiParameters, erc20Abi, http, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem'
import type { Quote, Token } from '../src/types'
import { SugarClient } from '../src/client'
import { getChainSettings } from '../src/config'
import { executeSugarAction } from '../src/actions'
import { extractPlanSteps } from '../src/send'
import { STOCKS, STOCK_USDC } from '../src/stocks/catalog'

const portReservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
const forkPort = portReservation.port
const rpcUrl = `http://127.0.0.1:${forkPort}`
portReservation.stop(true)
const owner: Address = '0x1111111111111111111111111111111111111111'
const forkSource = getChainSettings(8453).rpcUrl
const binary = process.env.AERO_BASE_ANVIL ?? Bun.which('base-anvil')
if (!binary) throw new Error('Install Base fork tools or set AERO_BASE_ANVIL to the Base anvil binary. Stock Anvil cannot execute B20 tokens.')
const cache = mkdtempSync(join(tmpdir(), 'aero-stock-fork-'))
const processFork = Bun.spawn([binary, '--base', '--fork-url', forkSource, '--port', String(forkPort), '--host', '127.0.0.1', '--chain-id', '8453', '--silent', '--gas-limit', '1000000000', '--cache-path', cache], { stdout: 'ignore', stderr: 'pipe' })
const forkErrors = new Response(processFork.stderr).text()
const chain = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 180000 }) })
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const result = await response.json()
  if (result.error) throw new Error(String(result.error.message))
  return result.result
}
try {
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    if (processFork.exitCode !== null) break
    try { await rpc('anvil_nodeInfo', []); ready = true; break } catch { await Bun.sleep(100) }
  }
  assert(ready, 'Local Anvil fork did not start')
  await rpc('anvil_impersonateAccount', [owner])
  await rpc('anvil_setBalance', [owner, toHex(parseUnits('100', 18))])
  const balance = (address: Address) => chain.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  const funding = parseUnits('1000', 6)
  let funded = false
  for (let index = 0; index < 30; index++) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, BigInt(index)]))
    const before = await chain.getStorageAt({ address: STOCK_USDC, slot })
    await rpc('anvil_setStorageAt', [STOCK_USDC, slot, toHex(funding, { size: 32 })])
    if (await balance(STOCK_USDC) === funding) { funded = true; break }
    await rpc('anvil_setStorageAt', [STOCK_USDC, slot, before])
  }
  assert(funded, 'Could not fund the local fork account')
  const live = new SugarClient(8453, { settings: { quoteMaxPaths: 128, quoteBatchSize: 32 } })
  class ForkClient extends SugarClient {
    override getAllTokens(listedOnly = false): Promise<Token[]> { return live.getAllTokens(listedOnly) }
    override getQuote(from: Token, to: Token, amount: bigint, filter?: (quote: Quote) => boolean): Promise<Quote | undefined> { return live.getQuote(from, to, amount, filter) }
  }
  const client = new ForkClient(8453, { account: owner, rpcUrl, publicClient: chain })
  const evidence: object[] = []
  async function execute(action: 'stock_buy' | 'stock_sell' | 'index_rebalance', parameters: Record<string, string>) {
    await client.invalidate()
    const result = await executeSugarAction(action, { chain: 8453, wallet: owner, ...parameters, slippage: 0.01 }, { clientFactory: () => client })
    const steps = extractPlanSteps(result)
    for (const step of steps) {
      const hash: Hex = await rpc('eth_sendTransaction', [{ from: owner, to: step.transaction.to, data: step.transaction.data, value: toHex(step.transaction.value), gas: '0x989680' }])
      const receipt = await chain.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        await Bun.write(join(tmpdir(), 'aero-stock-fork-revert.json'), JSON.stringify(await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }])))
      }
      assert.equal(receipt.status, 'success', `${action} ${step.role} reverted`)
    }
    evidence.push({ action, parameters, transactions: steps.length, usdc: String(await balance(STOCK_USDC)), nvda: String(await balance(STOCKS[0].address)), aapl: String(await balance(STOCKS[1].address)) })
    console.log(JSON.stringify(evidence.at(-1)))
  }
  await execute('stock_buy', { stock: 'NVDAc', amount: '20' })
  const bought = await balance(STOCKS[0].address)
  assert(bought > 0n)
  await execute('stock_sell', { stock: 'NVDAc', amount: '0.01' })
  assert(await balance(STOCKS[0].address) < bought)
  await execute('index_rebalance', { allocations: 'NVDAc=50,AAPLc=50', cash: '50' })
  assert(await balance(STOCKS[1].address) > 0n)
  await execute('index_rebalance', { allocations: 'NVDAc=0,AAPLc=100', cash: '0' })
  assert.equal(await balance(STOCKS[0].address), 0n)
  const cash = await client.getToken(STOCK_USDC)
  const nvda = await client.getToken(STOCKS[0].address)
  const aapl = await client.getToken(STOCKS[1].address)
  assert(cash && nvda && aapl)
  const first = await client.getQuote(cash, nvda, parseUnits('1', cash.decimals))
  const second = await client.getQuote(cash, aapl, parseUnits('1', cash.decimals))
  assert(first && second)
  const failing = await client.swapBasketFromQuotes([first, { ...second, amountOut: second.amountOut * 100n }], 0.01)
  const beforeRollback = await Promise.all([balance(STOCK_USDC), balance(STOCKS[0].address), balance(STOCKS[1].address)])
  for (let index = 0; index < failing.length; index++) {
    const transaction = failing[index]
    const hash: Hex = await rpc('eth_sendTransaction', [{ from: owner, to: transaction.to, data: transaction.data, value: toHex(transaction.value), gas: '0x989680' }])
    const receipt = await chain.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, index === failing.length - 1 ? 'reverted' : 'success')
  }
  assert.deepEqual(await Promise.all([balance(STOCK_USDC), balance(STOCKS[0].address), balance(STOCKS[1].address)]), beforeRollback)
  console.log(JSON.stringify({ atomicRollback: true }))
  console.log(JSON.stringify({ ok: true, atomicRollback: true, mode: 'local-base-fork', mainnetBroadcast: false, evidence }, null, 2))
} catch (cause) {
  let current: unknown = cause
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    console.error(current.name, current.message.split('\n')[0])
    current = current.cause
  }
  process.exitCode = 1
} finally {
  processFork.kill()
  await processFork.exited
  const errors = await forkErrors
  if (errors) console.error(errors.replaceAll(forkSource, '[fork RPC]').slice(0, 2000))
  rmSync(cache, { recursive: true, force: true })
}
