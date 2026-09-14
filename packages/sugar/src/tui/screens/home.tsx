import type { ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import { fetchTuiLlama } from '../sugar'
import { formatUsd } from '../format'
import { AeroMark } from '../logo'
import { theme } from '../theme'
import { useApp, type Route } from '../store'
import { StatusBar } from '../widgets'

type MenuItem = { title: string; description: string; route: Route }

/**
 * The start screen, and the first half of the command palette. Everything
 * else (claims, staking, epoch history) is reached from Positions/Pools rows
 * or the palette; quit and palette live in the status bar as keys.
 */
export const HOME_MENU: MenuItem[] = [
  { title: 'Swap', description: 'trade through the best route', route: { name: 'action', action: 'swap' } },
  { title: 'Quote', description: 'price a swap without sending', route: { name: 'action', action: 'quote' } },
  { title: 'Pools', description: 'browse liquidity pools', route: { name: 'pools' } },
  { title: 'Add liquidity', description: 'deposit into a pool or create one', route: { name: 'action', action: 'deposit' } },
  { title: 'Positions', description: 'your liquidity, staking, and claims', route: { name: 'positions' } },
  { title: 'Stocks', description: 'buy, sell, and browse holdings', route: { name: 'stocks' } },
  { title: 'Indices', description: 'custom percentages and rebalancing', route: { name: 'indices' } },
  { title: 'Epochs', description: 'votes, emissions, and bribes', route: { name: 'epochs' } },
  { title: 'Analytics', description: 'E/R, RPV, and Base share', route: { name: 'analytics' } },
  { title: 'Lock veNFT', description: 'lock AERO/VELO for voting power', route: { name: 'action', action: 'create_venft' } },
  { title: 'Wallet', description: 'connect, create, or remove wallets', route: { name: 'wallet' } },
]

const MENU = HOME_MENU

/** Live DefiLlama pulse under the logo; hidden entirely until data lands. */
function LiveStats() {
  const chain = useApp().chain
  const [stats, setStats] = useState<{ chain: number; tvl?: number; fees24h?: number; volume24h?: number }>()
  useEffect(() => {
    let cancelled = false
    fetchTuiLlama(chain).then((llama) => {
      if (!cancelled) setStats(llama ? { chain, tvl: llama.tvlNow, fees24h: llama.fees24h, volume24h: llama.volume24h } : undefined)
    }).catch(() => { if (!cancelled) setStats(undefined) })
    return () => {
      cancelled = true
    }
  }, [chain])
  if (stats?.chain !== chain || (stats.tvl === undefined && stats.fees24h === undefined)) return null
  return (
    <box flexShrink={0} flexDirection="row" gap={2} justifyContent="center">
      {stats.tvl !== undefined ? <text fg={theme.text}>TVL <span fg={theme.success}>{formatUsd(stats.tvl)}</span></text> : null}
      {stats.volume24h !== undefined ? <text fg={theme.text}>vol 24h <span fg={theme.primary}>{formatUsd(stats.volume24h)}</span></text> : null}
      {stats.fees24h !== undefined ? <text fg={theme.text}>fees 24h <span fg={theme.warning}>{formatUsd(stats.fees24h)}</span></text> : null}
      <text fg={theme.textMuted}>defillama.com</text>
    </box>
  )
}

export function HomeScreen() {
  const app = useApp()
  const dimensions = useTerminalDimensions()
  const compact = dimensions.height < 30 || dimensions.width < 100
  const scroll = useRef<ScrollBoxRenderable>(null)
  const [selected, setSelected] = useState(0)
  // Several key events can land in one input chunk (fast ↓↓⏎); reading state
  // in the handler would activate a stale entry, so the live index is a ref.
  const selectedRef = useRef(0)
  useEffect(() => {
    const viewport = scroll.current
    if (!viewport) return
    if (selected < viewport.scrollTop) viewport.scrollTop = selected
    else if (selected >= viewport.scrollTop + viewport.viewport.height) viewport.scrollTop = selected - viewport.viewport.height + 1
  }, [selected, dimensions.height])
  const select = (next: number) => {
    selectedRef.current = next
    setSelected(next)
  }

  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'up' || key.name === 'k') return select((selectedRef.current + MENU.length - 1) % MENU.length)
    if (key.name === 'down' || key.name === 'j') return select((selectedRef.current + 1) % MENU.length)
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') return app.push(MENU[selectedRef.current].route)
    if (key.name === 'q') return app.quit()
  })

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box flexGrow={1} minHeight={0} alignItems="center">
        <box flexGrow={1} maxHeight={3} minHeight={0} />
        <box flexShrink={0} alignItems="center">
          {compact ? <text fg={theme.primary}>AERO</text> : <box flexDirection="row" gap={2} alignItems="center">
            <AeroMark />
            <ascii-font font="block" text="AERO" color={theme.primary} />
          </box>}
          {!compact ? <LiveStats /> : null}
        </box>
        <box height={1} flexShrink={0} />
        <scrollbox ref={scroll} flexGrow={1} minHeight={0} maxHeight={MENU.length} width={Math.min(64, dimensions.width - 4)}>
          {MENU.map((item, index) => {
            const active = index === selected
            return (
              <box
                key={item.title}
                height={1}
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active ? theme.primary : undefined}
              >
                <text fg={active ? theme.selectedText : theme.text}>
                  {item.title}
                  <span fg={active ? theme.selectedText : theme.textMuted}>  {item.description}</span>
                </text>
              </box>
            )
          })}
        </scrollbox>
        <box flexGrow={1} minHeight={0} />
      </box>
      <StatusBar
        hints={[
          { key: '↑↓', label: 'move' },
          { key: 'enter', label: 'open' },
          { key: 'ctrl+k', label: 'commands' },
          { key: 'c', label: 'chain' },
          { key: 'q', label: 'quit' },
        ]}
      />
    </box>
  )
}
