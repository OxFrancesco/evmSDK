import { expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import * as sugar from '../sugar'
import * as wallet from '../../wallet'
import { AppProvider } from '../store'
import { ActionScreen } from './action'

test('opening the picker retries a failed catalog load', async () => {
  const active = spyOn(wallet, 'getActiveWallet').mockReturnValue(undefined)
  const catalog = spyOn(sugar, 'tuiTokenCatalog')
    .mockRejectedValueOnce(new Error('RPC unavailable'))
    .mockResolvedValue([])
  const ui = await testRender(
    <AppProvider onQuit={() => {}}><ActionScreen action="swap" /></AppProvider>,
    { width: 80, height: 24 },
  )
  try {
    await act(async () => {})
    await ui.renderOnce()
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    expect(catalog).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => { ui.renderer.destroy() })
    active.mockRestore()
    catalog.mockRestore()
  }
})
