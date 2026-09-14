import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './app'
import { AppProvider } from './store'
import { stopTuiWorker } from './sugar'

/**
 * Boot the full-screen TUI and resolve once the user quits, so the `aero tui`
 * subcommand can hold the CLI runtime open for the whole session. ctrl+c is
 * handled inside `App` so a running broadcast can ask for a second press.
 */
export async function runAeroTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
  })
  await new Promise<void>((resolve) => {
    const root = createRoot(renderer)
    let done = false
    const quit = () => {
      if (done) return
      done = true
      stopTuiWorker()
      root.unmount()
      renderer.destroy()
      resolve()
    }
    root.render(
      <AppProvider onQuit={quit}>
        <App />
      </AppProvider>,
    )
  })
}
