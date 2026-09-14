import { expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as wallet from '../wallet'
import * as sugar from './sugar'
import { parseAllocations, STOCKS } from '../stocks/catalog'
import { saveIndex } from '../stocks/indices'
import { AppProvider } from './store'
import { App } from './app'

test('full TUI navigation prioritizes liquidity and carries custom weights into a reviewed rebalance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aero-simulator-'))
  const previous = process.env.AERO_INDEX_DIR
  process.env.AERO_INDEX_DIR = directory
  saveIndex('custom', 'NVDAc=0,AAPLc=37.25,GOOGLc=62.75')
  const sender = '0x1111111111111111111111111111111111111111'
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue({ source: 'local', address: sender })
  const warm = spyOn(sugar, 'warmChain').mockImplementation(() => {})
  const llama = spyOn(sugar, 'fetchTuiLlama').mockResolvedValue(undefined)
  const catalog = spyOn(sugar, 'tuiTokenCatalog').mockResolvedValue([])
  const browse = spyOn(sugar, 'subscribeTuiAction').mockImplementation((_action, _parameters, callback) => {
    callback({ data: [], stale: false, refreshing: false })
    return () => {}
  })
  const request = spyOn(sugar, 'runTuiAction').mockImplementation(async (action, parameters) => {
    if (action === 'stocks') return STOCKS.map((stock) => ({ ...stock, price_usdc: '100', balance: stock.symbol === 'AAPLc' ? '2' : '0', error: null }))
    if (action !== 'index_rebalance') throw new Error(`Unexpected simulator request: ${action}`)
    return {
      transaction_steps: [{ role: 'action', transaction: { from: sender, to: sender, data: '0x', value: '0' } }],
      allocation: parseAllocations(String(parameters.allocations)).map(({ stock, weightBps }) => ({ symbol: stock.symbol, current_pct: 0, target_pct: weightBps / 100 })),
      trades: [{ amount: '25', from: 'USDC', expected: '0.25', to: 'AAPLc', minimum: '0.24875' }],
    }
  })
  const ui = await act(() => testRender(<AppProvider onQuit={() => {}}><App /></AppProvider>, { width: 80, height: 24, kittyKeyboard: true }))
  const key = async (value: string, ctrl = false) => {
    await act(async () => { ui.mockInput.pressKey(value, { ctrl }); await ui.renderOnce() })
    await ui.renderOnce()
  }
  const type = async (value: string) => { await act(async () => { await ui.mockInput.typeText(value) }); await ui.renderOnce() }
  const capture = async (name: string) => {
    if (!process.env.AERO_TUI_CAPTURE_DIR) return
    await Bun.write(join(process.env.AERO_TUI_CAPTURE_DIR, `${name}.txt`), ui.captureCharFrame())
    await Bun.write(join(process.env.AERO_TUI_CAPTURE_DIR, `${name}.json`), JSON.stringify(ui.captureSpans()))
  }
  try {
    await act(async () => { await ui.renderOnce() })
    const home = ui.captureCharFrame()
    expect(home.indexOf('Swap')).toBeLessThan(home.indexOf('Pools'))
    expect(home.indexOf('Pools')).toBeLessThan(home.indexOf('Add liquidity'))
    expect(home.indexOf('Add liquidity')).toBeLessThan(home.indexOf('Stocks'))
    // Quit and the palette are status-bar keys, not menu rows.
    expect(home).toContain('q quit')
    expect(home).not.toContain('All commands')
    await capture('home')
    await key('RETURN')
    expect(ui.captureCharFrame()).toContain('From token')
    await key('ESCAPE')
    await key('ARROW_DOWN')
    await key('ARROW_DOWN')
    await key('RETURN')
    expect(ui.captureCharFrame()).toContain('No pools matched')
    await key('n', true)
    const depositForm = ui.captureCharFrame()
    expect(depositForm).toContain('Add liquidity')
    // CL-only range fields stay hidden until the pool type is CL or "More options" is on.
    expect(depositForm).not.toContain('Tick spacing')
    expect(depositForm).toContain('More options')
    await capture('pool-form')
    await key('k', true)
    const palette = ui.captureCharFrame()
    expect(palette.indexOf('Swap')).toBeLessThan(palette.indexOf('Stocks'))
    await type('Indices')
    await key('RETURN')
    await key('RETURN')
    expect(ui.captureCharFrame()).toContain('37.25%')
    expect(ui.captureCharFrame()).toContain('esc cancel')
    await capture('index-editor')
    await key('r')
    expect(ui.captureCharFrame()).toContain('Target weights')
    await key('ARROW_DOWN')
    await type('25')
    // Slippage sits behind "More options"; toggling keeps the cursor on the toggle row.
    await key('ARROW_DOWN')
    expect(ui.captureCharFrame()).not.toContain('Slippage')
    await key('ARROW_RIGHT')
    expect(ui.captureCharFrame()).toContain('Slippage')
    await key('ARROW_UP')
    await type('0.005')
    await capture('rebalance-form')
    await key('r', true)
    expect(request).toHaveBeenLastCalledWith('index_rebalance', { chain: 8453, wallet: sender, allocations: 'NVDAc=0,AAPLc=37.25,GOOGLc=62.75', cash: '25', slippage: 0.005 }, { fresh: false })
    expect(ui.captureCharFrame()).toContain('37.25%')
    expect(ui.captureCharFrame()).toContain('minimum 0.24875')
    await capture('rebalance-preview')
    await key('ESCAPE')
    expect(ui.captureCharFrame()).toContain('Add USDC')
    await key('k', true)
    await type('Stocks')
    await key('RETURN')
    await key('h')
    expect(ui.captureCharFrame()).toContain('AAPLc')
    expect(ui.captureCharFrame()).not.toContain('NVDAc')
    await capture('stock-holdings')
    await key('h')
    expect(ui.captureCharFrame()).toContain('NVDAc')
    await key('o')
    await key('ARROW_DOWN')
    await key('RETURN')
    await key('s')
    expect(ui.captureCharFrame()).toContain('GOOGLc')
  } finally {
    await act(async () => { ui.renderer.destroy() })
    for (const mock of [active, warm, llama, catalog, browse, request]) mock.mockRestore()
    if (previous === undefined) delete process.env.AERO_INDEX_DIR
    else process.env.AERO_INDEX_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
