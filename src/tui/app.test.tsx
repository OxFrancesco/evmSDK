import { expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { Schema } from 'effect'
import { commands } from '../catalog'
import { outputSchemas } from '../outputs'
import { forms } from './forms'
import { App } from './app'

const address = '0x1111111111111111111111111111111111111111'
const hash = `0x${'a'.repeat(64)}`
const plan = { id: 'test-plan', key: 'test-write', chainId: 31337, account: address, to: address, data: '0x', value: '0', intentHash: hash, fingerprint: hash, createdAt: 0, expiresAt: 600_000, simulationBlock: '1', gas: '25200', gasPrice: '1000000000' }

test('every agent command has a TUI form and published output schema', () => {
  for (const command of commands) {
    expect(forms.has(command.name)).toBe(true)
    expect(outputSchemas.has(command.name)).toBe(true)
  }
})

test('80 by 24 layout keeps the header and command menu readable', async () => {
  const ui = await testRender(<App quit={() => {}} run={async () => ({ ok: true, value: null })} />, { width: 80, height: 24 })
  try {
    await ui.renderOnce()
    const frame = ui.captureCharFrame()
    expect(frame).toContain('EVM  Tab fields')
    expect(frame).toContain('Contract address')
    expect(frame).toContain('inspect')
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('keyboard form submission passes the selected chain and account to the shared command', async () => {
  const calls: Array<{ name: string; input: Schema.Json }> = []
  const ui = await testRender(<App quit={() => {}} run={async (name, input) => {
    calls.push({ name, input }); return { ok: true, value: { balanceWei: '123' } }
  }} />, { width: 100, height: 30 })
  try {
    await act(async () => { for (let i = 0; i < 10; i++) ui.mockInput.pressArrow('down') })
    await act(async () => { ui.mockInput.pressKey('TAB'); ui.mockInput.pressKey('TAB'); await ui.mockInput.typeText(address) })
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    await ui.renderOnce()
    expect(calls).toEqual([{ name: 'balance', input: { chainId: 8453, address } }])
    expect(ui.captureCharFrame()).toContain('balanceWei: 123')
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('operation selection exposes review and binds approval to the displayed plan', async () => {
  const calls: Array<{ name: string; input: Schema.Json }> = []
  const ui = await testRender(<App quit={() => {}} run={async (name, input) => {
    calls.push({ name, input })
    return { ok: true, value: name === 'operations' ? [{ plan, state: { _tag: 'prepared' } }] : { plan, state: { _tag: 'confirmed', hash, block: '2', gasUsed: '21000' } } }
  }} />, { width: 100, height: 40 })
  try {
    await act(async () => { for (let i = 0; i < 8; i++) ui.mockInput.pressArrow('down') })
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    await act(async () => ui.mockInput.pressKey('TAB'))
    await act(async () => ui.mockInput.pressEnter())
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('Ctrl+E executes')
    expect(calls.map(call => call.name)).toEqual(['operations'])
    await act(async () => ui.mockInput.pressKey('e', { ctrl: true }))
    await ui.renderOnce()
    expect(calls[1]).toEqual({ name: 'execute', input: { id: plan.id, approval: { _tag: 'approved', fingerprint: hash } } })
    expect(ui.captureCharFrame()).toContain('confirmed')
    expect(ui.captureCharFrame()).not.toContain('Ctrl+E executes')
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('contract function selection fills the matching read form', async () => {
  const ui = await testRender(<App quit={() => {}} run={async () => ({ ok: true, value: {
    address, implementation: null, source: 'provided', block: '1', abi: [{ type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
  } })} />, { width: 100, height: 40 })
  try {
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    for (let i = 0; i < 6; i++) await act(async () => ui.mockInput.pressKey('TAB'))
    await act(async () => ui.mockInput.pressEnter())
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('Arguments JSON')
    expect(ui.captureCharFrame()).toContain('▶ read')
    expect(ui.captureCharFrame()).toContain('count')
    expect(ui.captureCharFrame()).toContain(address)
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('wallet shortcut exposes connection methods and search opens Socket forms', async () => {
  const calls: Array<{ name: string; input: Schema.Json }> = []
  const ui = await testRender(<App quit={() => {}} run={async (name, input) => { calls.push({ name, input }); return { ok: true, value: null } }} />, { width: 100, height: 40 })
  try {
    await act(async () => ui.mockInput.pressKey('w', { ctrl: true }))
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('Browser wallet')
    await act(async () => { ui.mockInput.pressKey('TAB'); ui.mockInput.pressArrow('down') })
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    expect(calls[0]).toEqual({ name: 'wallet-connect', input: { kind: 'walletconnect', chainId: 8453, name: 'main' } })
    await act(async () => { ui.mockInput.pressKey('k', { ctrl: true }); await ui.mockInput.typeText('socket-tokens') })
    await act(async () => ui.mockInput.pressEnter())
    await act(async () => { ui.mockInput.pressKey('TAB'); ui.mockInput.pressKey('TAB'); await ui.mockInput.typeText('USDC') })
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    expect(calls[1]).toEqual({ name: 'socket-tokens', input: { chainId: 8453, query: 'USDC' } })
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('an unresolved smart-wallet operation retains its exact approval action in the TUI', async () => {
  const calls: Array<{ name: string; input: Schema.Json }> = []
  const pending = { plan, remote: { provider: 'crossmint', id: 'existing-provider-id', userOperationHash: hash }, state: { _tag: 'walletPending', hash: null, nonce: -1 } }
  const ui = await testRender(<App quit={() => {}} run={async (name, input) => { calls.push({ name, input }); return { ok: true, value: name === 'operations' ? [pending] : pending } }} />, { width: 100, height: 40 })
  try {
    await act(async () => { ui.mockInput.pressKey('k', { ctrl: true }); await ui.mockInput.typeText('operations') })
    await act(async () => ui.mockInput.pressEnter())
    await act(async () => ui.mockInput.pressKey('r', { ctrl: true }))
    await act(async () => ui.mockInput.pressKey('TAB'))
    await act(async () => ui.mockInput.pressEnter())
    await ui.renderOnce()
    expect(ui.captureCharFrame()).toContain('Ctrl+E executes')
    await act(async () => ui.mockInput.pressKey('e', { ctrl: true }))
    expect(calls[1]).toEqual({ name: 'execute', input: { id: plan.id, approval: { _tag: 'approved', fingerprint: plan.fingerprint } } })
  } finally { await act(async () => ui.renderer.destroy()) }
})

test('selected wallet fills bridge sender and receiver without overwriting manual input', async () => {
  const ui = await testRender(<App quit={() => {}} getWallet={async () => address} run={async () => ({ ok: true, value: null })} />, { width: 100, height: 45 })
  try {
    await act(async () => { ui.mockInput.pressKey('k', { ctrl: true }); await ui.mockInput.typeText('bridge-prepare') })
    await act(async () => ui.mockInput.pressEnter())
    await ui.renderOnce()
    expect(ui.captureCharFrame().split(address).length).toBe(3)
  } finally { await act(async () => ui.renderer.destroy()) }
})
