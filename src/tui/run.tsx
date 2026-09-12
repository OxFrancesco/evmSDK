import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { dispatch } from '../catalog'
import { runtimeLayer } from '../runtime'
import type { RuntimeOptions } from '../runtime'
import { App } from './app'

export async function runTui(options: RuntimeOptions) {
  let onPairing: ((message: string) => void) | undefined
  const subscribePairing = (listener: (message: string) => void) => { onPairing = listener; return () => { onPairing = undefined } }
  const runtime = ManagedRuntime.make(runtimeLayer({ ...options, interactive: true, onPairing: message => onPairing?.(message) }))
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
  const root = createRoot(renderer)
  const getWallet = () => runtime.runPromise(dispatch('wallet', {}).pipe(Effect.map(value => Schema.decodeUnknownSync(Schema.Struct({ address: Schema.NullOr(Schema.String) }))(value).address)))
  try {
    await new Promise<void>(resolve => {
      root.render(<App getWallet={getWallet} subscribePairing={subscribePairing} quit={resolve} run={(name, input) => runtime.runPromise(dispatch(name, input).pipe(Effect.match({
        onSuccess: value => ({ ok: true, value }),
        onFailure: error => ({ ok: false, value: { code: error.code, message: error.message } }),
      })))} />)
    })
  } finally {
    root.unmount()
    renderer.destroy()
    await runtime.dispose()
  }
}
