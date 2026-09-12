import { TextAttributes } from '@opentui/core'
import { useTerminalDimensions } from '@opentui/react'
import { Fragment, useEffect, useState } from 'react'
import { getChainSettings } from '../config'
import { subscribeTuiRpcActivity, tuiRpcReadCount } from './sugar'
import { theme } from './theme'
import { useApp, type ToastVariant } from './store'

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Live RPC reads completed since this spinner mounted — visible scan progress. */
function useRpcActivity(enabled: boolean): number {
  const [reads, setReads] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const base = tuiRpcReadCount()
    return subscribeTuiRpcActivity(() => setReads(tuiRpcReadCount() - base))
  }, [enabled])
  return enabled ? reads : 0
}

export function Spinner(props: { label?: string; activity?: boolean }) {
  const [frame, setFrame] = useState(0)
  const reads = useRpcActivity(props.activity === true)
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  const label = reads > 0 ? `${props.label ?? ''} ${reads} rpc reads`.trim() : props.label
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.primary}>{SPINNER_FRAMES[frame]}</text>
      {label ? <text fg={theme.textMuted}>{label}</text> : null}
    </box>
  )
}

export function KeyHints(props: { hints: { key: string; label: string }[] }) {
  return (
    <text fg={theme.textMuted}>
      {props.hints.map((hint, index) => (
        <Fragment key={hint.key + hint.label}>
          {index > 0 ? <span>  </span> : null}
          <span fg={theme.text}>{hint.key}</span>
          <span> {hint.label}</span>
        </Fragment>
      ))}
    </text>
  )
}

const TOAST_COLORS = {
  info: theme.info,
  success: theme.success,
  warning: theme.warning,
  error: theme.error,
} satisfies Record<ToastVariant, string>

export function Toasts() {
  const { toasts } = useApp()
  const dimensions = useTerminalDimensions()
  if (toasts.length === 0) return null
  return (
    <box position="absolute" top={1} right={2} maxWidth={Math.min(60, dimensions.width - 6)} gap={1} zIndex={200}>
      {toasts.map((item) => (
        <box
          key={item.id}
          backgroundColor={theme.backgroundPanel}
          border={['left']}
          borderColor={TOAST_COLORS[item.variant]}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={TOAST_COLORS[item.variant]} attributes={TextAttributes.BOLD}>{item.title}</text>
          {item.message ? <text fg={theme.text}>{item.message}</text> : null}
        </box>
      ))}
    </box>
  )
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function chainLabel(chainId: number): string {
  try {
    return getChainSettings(chainId).chainName
  } catch {
    return String(chainId)
  }
}

export function StatusBar(props: { hints: { key: string; label: string }[] }) {
  const { chain, wallet } = useApp()
  return (
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} flexShrink={0}>
      <KeyHints hints={props.hints} />
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.text}>
          <span fg={theme.primary}>⬡</span> {chainLabel(chain)}
        </text>
        {wallet ? (
          <text fg={theme.text}>
            <span fg={theme.success}>●</span> {shortAddress(wallet.address)}
            <span fg={theme.textMuted}> {wallet.source === 'walletconnect' ? (wallet.peer ?? 'walletconnect') : 'local'}</span>
          </text>
        ) : (
          <text fg={theme.textMuted}>
            <span>○</span> no wallet
          </text>
        )}
      </box>
    </box>
  )
}

export function ScreenFrame(props: { title: string; hints: { key: string; label: string }[]; children: React.ReactNode }) {
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box height={1} paddingLeft={2} paddingRight={2} flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>{props.title}</text>
        <text fg={theme.textMuted}>aero</text>
      </box>
      <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        {props.children}
      </box>
      <StatusBar hints={props.hints} />
    </box>
  )
}
