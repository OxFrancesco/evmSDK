import { expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import { SelectDialog } from './dialogs'

test('filtering after navigation selects the highlighted first match', async () => {
  let picked = ''
  const ui = await testRender(
    <SelectDialog title="Tokens" close={() => {}} items={['AERO', 'ETH', 'WETH', 'USDC'].map((title) => ({
      title,
      onSelect: () => { picked = title },
    }))} />,
    { width: 80, height: 24 },
  )
  try {
    await ui.renderOnce()
    await act(async () => {
      ui.mockInput.pressArrow('down')
      ui.mockInput.pressArrow('down')
    })
    await ui.renderOnce()
    await act(async () => { await ui.mockInput.typeText('eth') })
    await ui.renderOnce()
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    expect(picked).toBe('ETH')
  } finally {
    await act(async () => { ui.renderer.destroy() })
  }
})

test('typing and submitting in one input batch selects the new match', async () => {
  let picked = ''
  const ui = await testRender(
    <SelectDialog title="Tokens" close={() => {}} items={['ETH', 'WETH', 'USDC'].map((title) => ({
      title,
      onSelect: () => { picked = title },
    }))} />,
    { width: 80, height: 24 },
  )
  try {
    await ui.renderOnce()
    await act(async () => {
      await ui.mockInput.typeText('usdc')
      ui.mockInput.pressEnter()
    })
    await ui.renderOnce()
    expect(picked).toBe('USDC')
  } finally {
    await act(async () => { ui.renderer.destroy() })
  }
})

test('reopening a token picker matches the saved full contract address', async () => {
  const address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  let picked = false
  const ui = await testRender(
    <SelectDialog title="Tokens" close={() => {}} initialFilter={address} items={[{
      title: 'USDC', description: '6 decimals · 0x8335…2913', searchText: address,
      onSelect: () => { picked = true },
    }]} />,
    { width: 80, height: 24 },
  )
  try {
    await ui.renderOnce()
    await act(async () => { ui.mockInput.pressEnter() })
    expect(picked).toBe(true)
  } finally {
    await act(async () => { ui.renderer.destroy() })
  }
})
