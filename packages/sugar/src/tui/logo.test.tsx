import { expect, spyOn, test } from 'bun:test'
import { act, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import { testRender } from '@opentui/react/test-utils'
import { AeroMark } from './logo'

test('the intro catches up to elapsed time and releases the render loop when idle', async () => {
  const ui = await act(() => testRender(<AeroMark />, { width: 30, height: 12 }))
  const now = performance.now.bind(performance)
  try {
    await act(async () => {})
    expect(ui.renderer.liveRequestCount).toBe(1)
    const clock = spyOn(performance, 'now').mockImplementation(() => now() + 2000)
    try {
      await act(async () => { await ui.renderOnce() })
      await ui.renderOnce()
      expect(ui.renderer.liveRequestCount).toBe(0)
      expect(ui.captureCharFrame()).toContain('█')
    } finally {
      clock.mockRestore()
    }
  } finally {
    await act(async () => { ui.renderer.destroy() })
  }
})

test('disabling motion during the intro renders the complete mark and stops animation', async () => {
  function ToggleMark() {
    const [animate, setAnimate] = useState(true)
    useKeyboard(() => setAnimate(false))
    return <AeroMark animate={animate} />
  }
  const ui = await act(() => testRender(<ToggleMark />, { width: 30, height: 12 }))
  try {
    await act(async () => {})
    expect(ui.renderer.liveRequestCount).toBe(1)
    await act(async () => { ui.mockInput.pressEnter() })
    await ui.renderOnce()
    expect(ui.renderer.liveRequestCount).toBe(0)
    expect(ui.captureCharFrame()).toContain('█')
  } finally {
    await act(async () => { ui.renderer.destroy() })
  }
})
