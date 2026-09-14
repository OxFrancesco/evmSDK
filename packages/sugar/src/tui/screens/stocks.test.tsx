import { expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as wallet from '../../wallet'
import * as sugar from '../sugar'
import { readIndex, listIndices, saveIndex } from '../../stocks/indices'
import { STOCKS } from '../../stocks/catalog'
import { AppProvider, useApp } from '../store'
import { IndexEditorScreen, IndicesScreen, StocksScreen } from './stocks'

function IndexHarness() {
  const app = useApp()
  return <>
    {app.route.name === 'index_editor' ? <IndexEditorScreen index={app.route.index} /> : app.route.name === 'action' ? <text>{app.route.action} {app.route.preset?.allocations} chain {app.chain}</text> : <IndicesScreen />}
    {app.dialogs.at(-1)?.node}
  </>
}

test('create and edit an index through keyboard controls, then delete it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aero-tui-index-'))
  const previous = process.env.AERO_INDEX_DIR
  process.env.AERO_INDEX_DIR = directory
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue(undefined)
  const ui = await testRender(<AppProvider onQuit={() => {}}><IndexHarness /></AppProvider>, { width: 80, height: 24 })
  const key = async (text: string) => { await act(async () => { await ui.mockInput.typeText(text) }); await ui.renderOnce() }
  const enter = async () => { await act(async () => { ui.mockInput.pressEnter() }); await ui.renderOnce() }
  const down = async () => { await act(async () => { ui.mockInput.pressArrow('down') }); await ui.renderOnce() }
  try {
    await act(async () => { await ui.renderOnce() })
    await key('n')
    await enter()
    await key('tech')
    await enter()
    await down()
    await enter()
    await key('50')
    await enter()
    await down()
    await enter()
    await key('50')
    await enter()
    expect(ui.captureCharFrame()).toContain('Allocated 100% / 100%')
    if (process.env.AERO_TUI_CAPTURE_DIR) await Bun.write(join(process.env.AERO_TUI_CAPTURE_DIR, 'index-editor.txt'), ui.captureCharFrame())
    await key('s')
    expect(readIndex('tech').allocations).toBe('NVDAc=50,AAPLc=50')
    expect(ui.captureCharFrame()).toContain('tech')
    if (process.env.AERO_TUI_CAPTURE_DIR) await Bun.write(join(process.env.AERO_TUI_CAPTURE_DIR, 'saved-index.txt'), ui.captureCharFrame())
    await enter()
    await down()
    await enter()
    await key('0')
    await enter()
    await down()
    await enter()
    await key('100')
    await enter()
    await key('s')
    expect(readIndex('tech').allocations).toBe('NVDAc=0,AAPLc=100')
    await key('d')
    expect(ui.captureCharFrame()).toContain('Delete tech?')
    await key('y')
    expect(listIndices()).toEqual([])
  } finally {
    await act(async () => { ui.renderer.destroy() })
    active.mockRestore()
    if (previous === undefined) delete process.env.AERO_INDEX_DIR
    else process.env.AERO_INDEX_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

function StockHarness() {
  const app = useApp()
  return <>{app.route.name === 'action' ? <text>{app.route.action} {app.route.preset?.stock}</text> : <StocksScreen />}{app.dialogs.at(-1)?.node}</>
}

test('rapid stock navigation opens the selected stock sell action', async () => {
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue(undefined)
  const request = spyOn(sugar, 'runTuiAction').mockResolvedValue(STOCKS.map((stock) => ({ ...stock, price_usdc: '100', balance: null, error: null })))
  const ui = await testRender(<AppProvider onQuit={() => {}}><StockHarness /></AppProvider>, { width: 80, height: 24 })
  try {
    await act(async () => { await ui.renderOnce() })
    expect(ui.captureCharFrame()).toContain('USDC / token')
    await act(async () => { ui.mockInput.pressArrow('down'); ui.mockInput.pressArrow('down'); await ui.mockInput.typeText('s') })
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('stock_sell GOOGLc')
  } finally {
    await act(async () => { ui.renderer.destroy() })
    active.mockRestore()
    request.mockRestore()
  }
})

test('index shortcuts save exact percentages and pass them to rebalancing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aero-tui-weights-'))
  const previous = process.env.AERO_INDEX_DIR
  process.env.AERO_INDEX_DIR = directory
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue(undefined)
  saveIndex('custom', 'NVDAc=0,AAPLc=50,GOOGLc=50')
  const ui = await testRender(<AppProvider onQuit={() => {}}><IndexHarness /></AppProvider>, { width: 80, height: 24 })
  const key = async (value: string) => { await act(async () => { await ui.mockInput.typeText(value) }); await ui.renderOnce() }
  try {
    await act(async () => { await ui.renderOnce() })
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    await act(async () => { ui.mockInput.pressArrow('down'); ui.mockInput.pressArrow('down'); ui.mockInput.pressArrow('right') })
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('1% over')
    await key('e')
    expect(ui.captureCharFrame()).toContain('Allocated 100% / 100%')
    await act(async () => { ui.mockInput.pressEnter() })
    await key('37.25')
    await act(async () => { ui.mockInput.pressEnter(); })
    await ui.renderOnce()
    await act(async () => { ui.mockInput.pressArrow('down') })
    await key('f')
    expect(ui.captureCharFrame()).toContain('62.75%')
    if (process.env.AERO_TUI_CAPTURE_DIR) await Bun.write(join(process.env.AERO_TUI_CAPTURE_DIR, 'custom-percentages.txt'), ui.captureCharFrame())
    await key('r')
    expect(readIndex('custom').allocations).toBe('NVDAc=0,AAPLc=37.25,GOOGLc=62.75')
    expect(ui.captureCharFrame()).toContain('index_rebalance NVDAc=0,AAPLc=37.25,GOOGLc=62.75 chain 8453')
  } finally {
    await act(async () => { ui.renderer.destroy() })
    active.mockRestore()
    if (previous === undefined) delete process.env.AERO_INDEX_DIR
    else process.env.AERO_INDEX_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('searching stocks trades the visible selection, including reordered API rows', async () => {
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue(undefined)
  const request = spyOn(sugar, 'runTuiAction').mockResolvedValue(STOCKS.toReversed().map((stock) => ({ ...stock, price_usdc: stock.symbol === 'AAPLc' ? '123' : '100', balance: null, error: null })))
  const ui = await testRender(<AppProvider onQuit={() => {}}><StockHarness /></AppProvider>, { width: 80, height: 24 })
  const key = async (value: string) => { await act(async () => { await ui.mockInput.typeText(value) }); await ui.renderOnce() }
  try {
    await act(async () => { await ui.renderOnce() })
    await key('/')
    await key('not-a-stock')
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    await key('s')
    expect(ui.captureCharFrame()).toContain('No matching stocks')
    await key('/')
    await key('apple')
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('123.00')
    expect(ui.captureCharFrame()).not.toContain('NVDAc')
    await key('s')
    expect(ui.captureCharFrame()).toContain('stock_sell AAPLc')
  } finally {
    await act(async () => { ui.renderer.destroy() })
    active.mockRestore()
    request.mockRestore()
  }
})
