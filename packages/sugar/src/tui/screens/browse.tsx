import type { ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatCliError } from '../../cli'
import type { SugarJson } from '../../types'
import { SelectDialog, type SelectItem } from '../dialogs'
import { fuzzyScore } from '../../fuzzy'
import { DITHER_COLORS, renderHBar, renderStackBar } from '../analytics/dither'
import { DitherLines, Legend } from '../analytics/view'
import { POOLS_BROWSE_PARAMETERS, subscribeTuiAction } from '../sugar'
import { formatAge, formatNumber, formatUsd, jsonNumber, jsonRecord, jsonString, pad } from '../format'
import { theme } from '../theme'
import { useApp } from '../store'
import { ScreenFrame, Spinner } from '../widgets'

export type Freshness = { savedAt?: number; stale: boolean; refreshing: boolean; refreshError?: string }

function useAction(action: 'pools' | 'positions' | 'epochs_latest', parameters: Record<string, string | number | boolean>) {
  const app = useApp()
  const [state, setState] = useState<{ loading: boolean; error?: string; data?: SugarJson; freshness?: Freshness }>({ loading: true })
  const [nonce, setNonce] = useState(0)
  const wallet = app.wallet?.address
  useEffect(() => {
    setState({ loading: true })
    const withWallet = action === 'positions' && wallet ? { ...parameters, wallet } : parameters
    return subscribeTuiAction(action, { chain: app.chain, ...withWallet }, (update) => {
      if (update.data === undefined) {
        setState({ loading: false, error: update.error === undefined ? undefined : formatCliError(update.error) })
        return
      }
      setState({
        loading: false,
        data: update.data,
        freshness: update.stale || update.refreshing
          ? {
            savedAt: update.savedAt,
            stale: update.stale,
            refreshing: update.refreshing,
            refreshError: update.error === undefined ? undefined : formatCliError(update.error),
          }
          : undefined,
      })
    }, { fresh: nonce > 0 })
  }, [action, app.chain, wallet, nonce])
  return { ...state, reload: () => setNonce((current) => current + 1) }
}

/** One-line badge for data served from a disk snapshot while the live scan runs. */
function FreshnessBanner(props: { freshness?: Freshness }) {
  const freshness = props.freshness
  if (!freshness) return null
  const age = freshness.savedAt === undefined ? '' : ` from ${formatAge(freshness.savedAt)}`
  return (
    <box height={1} flexShrink={0} paddingLeft={1}>
      {freshness.refreshError !== undefined ? (
        <text fg={theme.warning}>⚠ refresh failed — showing data{age} (ctrl+r to retry)</text>
      ) : (
        <text fg={theme.textMuted}>◌ data{age} — refreshing…</text>
      )}
    </box>
  )
}

export type BrowseRow = { key: string; line: string; searchText: string; actions?: SelectItem[]; bar?: { value: number; max: number; color?: 'green' | 'blue' | 'purple' } }

/** Cap the mounted rows; opentui culls offscreen boxes but React still pays per element. */
const MAX_VISIBLE_ROWS = 200

function BrowseList(props: {
  title: string
  header: string
  rows: BrowseRow[]
  loading: boolean
  error?: string
  freshness?: Freshness
  reload: () => void
  empty: string
  banner?: ReactNode
}) {
  const app = useApp()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  // The keyboard emitter can deliver several key events in one input chunk
  // (held arrow key, fast repeat). State reads inside the handler would see
  // the same stale value for the whole batch, so the live position lives in
  // a ref and state only mirrors it for rendering.
  const selectedRef = useRef(0)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const matched = useMemo(() => {
    const scored = props.rows
      .map((row, order) => ({ row, order, score: fuzzyScore(filter, row.searchText) }))
      .filter((entry): entry is { row: BrowseRow; order: number; score: number } => entry.score !== undefined)
    // Stable: equal fuzzy scores keep the caller's ordering (e.g. TVL rank).
    return scored.sort((left, right) => left.score - right.score || left.order - right.order).map((entry) => entry.row)
  }, [props.rows, filter])
  const filtered = useMemo(() => matched.slice(0, MAX_VISIBLE_ROWS), [matched])
  const overflow = matched.length - filtered.length
  const active = Math.min(selected, Math.max(0, filtered.length - 1))

  const select = (next: number) => {
    const clamped = Math.max(0, Math.min(next, filtered.length - 1))
    selectedRef.current = clamped
    setSelected(clamped)
  }

  // Keep the active row inside the scrollbox viewport (rows are one line tall).
  useEffect(() => {
    const scrollbox = scrollRef.current
    if (!scrollbox) return
    const viewportHeight = Math.max(1, scrollbox.viewport.height)
    if (active < scrollbox.scrollTop) scrollbox.scrollTop = active
    else if (active >= scrollbox.scrollTop + viewportHeight) scrollbox.scrollTop = active - viewportHeight + 1
  }, [active])

  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') return app.pop()
    if (key.ctrl && key.name === 'r') return props.reload()
    if (key.name === 'up') return select(selectedRef.current - 1)
    if (key.name === 'down') return select(selectedRef.current + 1)
    if (key.name === 'pageup') return select(selectedRef.current - 10)
    if (key.name === 'pagedown') return select(selectedRef.current + 10)
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
      const row = filtered[Math.min(selectedRef.current, filtered.length - 1)]
      if (row?.actions?.length) {
        app.openDialog((close) => <SelectDialog title={row.searchText} items={row.actions!} close={close} />)
      }
    }
  })

  const hints = [
    { key: '↑↓', label: 'move' },
    { key: 'enter', label: 'actions' },
    { key: 'ctrl+r', label: 'refresh' },
    { key: 'esc', label: 'back' },
  ]

  return (
    <ScreenFrame title={props.title} hints={hints}>
      <box flexGrow={1} minHeight={0}>
        <box height={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundElement}>
          <input
            focused={!app.dialogOpen}
            value={filter}
            placeholder="Type to filter..."
            onInput={(value) => {
              setFilter(value)
              select(0)
            }}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
          />
        </box>
        {props.banner}
        <FreshnessBanner freshness={props.freshness} />
        {props.loading ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <Spinner label="Loading..." activity />
          </box>
        ) : props.error ? (
          <box flexGrow={1} paddingTop={1} paddingLeft={1}>
            <text fg={theme.error}>{props.error}</text>
            <text fg={theme.textMuted}>ctrl+r to retry</text>
          </box>
        ) : (
          <box flexGrow={1} minHeight={0} paddingTop={1}>
            <box height={1} flexShrink={0} paddingLeft={1}>
              <text fg={theme.textMuted}>{props.header}</text>
            </box>
            {filtered.length === 0 ? (
              <box paddingLeft={1} paddingTop={1}>
                <text fg={theme.textMuted}>{props.empty}</text>
              </box>
            ) : (
              <scrollbox ref={scrollRef} flexGrow={1} minHeight={0}>
                {filtered.map((row, index) => (
                  <box key={row.key} height={1} paddingLeft={1} flexDirection="row" backgroundColor={index === active ? theme.primary : undefined}>
                    <text fg={index === active ? theme.selectedText : theme.text}>{row.line}</text>
                    {row.bar && row.bar.max > 0 ? (
                      <DitherLines rows={[renderHBar({
                        value: row.bar.value,
                        max: row.bar.max,
                        width: 10,
                        color: row.bar.color ?? 'blue',
                        y: index,
                        variant: 'solid',
                      })]} />
                    ) : null}
                  </box>
                ))}
                {overflow > 0 ? (
                  <box height={1} paddingLeft={1}>
                    <text fg={theme.textMuted}>… {overflow} more — refine the filter</text>
                  </box>
                ) : null}
              </scrollbox>
            )}
          </box>
        )}
      </box>
    </ScreenFrame>
  )
}

const scaled = (value: SugarJson | undefined, decimals = 18): number => {
  const raw = jsonString(value) ?? (jsonNumber(value) === undefined ? undefined : String(jsonNumber(value)))
  return raw === undefined ? 0 : Number(raw) / 10 ** decimals
}

export function PoolsScreen() {
  const app = useApp()
  const { loading, error, data, freshness, reload } = useAction('pools', POOLS_BROWSE_PARAMETERS)
  const rows = useMemo<BrowseRow[]>(() => {
    if (!Array.isArray(data)) return []
    const entries = data.flatMap((entry) => {
      const pool = jsonRecord(entry)
      if (!pool) return []
      const lp = jsonString(pool.lp) ?? ''
      const symbol = jsonString(pool.symbol) ?? lp
      const tvl = jsonNumber(pool.tvl)
      const line = [
        pad(symbol, 34),
        pad(jsonString(pool.type_label) ?? '', 10),
        pad(tvl === undefined ? '-' : formatUsd(tvl), 12),
        pool.gauge_alive === true ? '● gauge' : '',
      ].join(' ')
      const row: BrowseRow = {
        key: lp,
        line,
        searchText: `${symbol} ${jsonString(pool.type_label) ?? ''} ${lp}`,
        actions: [
          { title: 'Deposit liquidity', description: symbol, onSelect: () => app.push({ name: 'action', action: 'deposit', preset: { pool: lp } }) },
          { title: 'Epoch history', description: 'votes, emissions, fees', onSelect: () => app.push({ name: 'action', action: 'epochs', preset: { lp } }) },
          { title: 'Pool address', description: lp, onSelect: () => app.toast('info', symbol, lp) },
        ],
      }
      return [{ row, tvl: tvl ?? 0 }]
    })
    const sorted = entries.sort((left, right) => right.tvl - left.tvl)
    const maxTvl = sorted[0]?.tvl ?? 0
    return sorted.map((entry) => ({
      ...entry.row,
      bar: entry.tvl > 0 && maxTvl > 0 ? { value: entry.tvl, max: maxTvl, color: 'blue' as const } : undefined,
    }))
  }, [data, app])
  return (
    <BrowseList
      title="Pools"
      header={`${pad('POOL', 34)} ${pad('TYPE', 10)} ${pad('TVL', 12)}`}
      rows={rows}
      loading={loading}
      error={error}
      freshness={freshness}
      reload={reload}
      empty="No pools matched"
    />
  )
}

export function PositionsScreen() {
  const app = useApp()
  const { loading, error, data, freshness, reload } = useAction('positions', {})
  const rows = useMemo<BrowseRow[]>(() => {
    if (!Array.isArray(data)) return []
    return data.flatMap((entry) => {
      const position = jsonRecord(entry)
      const pool = position ? jsonRecord(position.pool) : undefined
      if (!position || !pool) return []
      const id = jsonString(position.id) ?? String(jsonNumber(position.id) ?? '')
      const lp = jsonString(pool.lp) ?? ''
      const symbol = jsonString(pool.symbol) ?? lp
      const token0 = jsonRecord(pool.token0)
      const token1 = jsonRecord(pool.token1)
      const decimals0 = jsonNumber(token0?.decimals) ?? 18
      const decimals1 = jsonNumber(token1?.decimals) ?? 18
      const isStaked = scaled(position.staked, 0) > 0
      const amount0 = scaled(position.amount_token0, decimals0) + scaled(position.staked_token0, decimals0)
      const amount1 = scaled(position.amount_token1, decimals1) + scaled(position.staked_token1, decimals1)
      const emissions = scaled(position.emissions_earned)
      const line = [
        pad(symbol, 30),
        pad(id, 8),
        pad(formatNumber(amount0), 12),
        pad(formatNumber(amount1), 12),
        pad(isStaked ? 'staked' : 'unstaked', 9),
        emissions > 0 ? formatNumber(emissions) : '',
      ].join(' ')
      const preset = { pool: lp, position: id }
      return [{
        key: `${lp}:${id}`,
        line,
        searchText: `${symbol} ${id} ${isStaked ? 'staked' : 'unstaked'} ${lp}`,
        actions: [
          { title: 'Withdraw', description: 'remove liquidity', onSelect: () => app.push({ name: 'action', action: 'withdraw', preset }) },
          { title: 'Stake', description: 'earn emissions in the gauge', onSelect: () => app.push({ name: 'action', action: 'stake', preset }) },
          { title: 'Unstake', description: 'leave the gauge', onSelect: () => app.push({ name: 'action', action: 'unstake', preset }) },
          { title: 'Claim emissions', description: 'staked positions', onSelect: () => app.push({ name: 'action', action: 'claim_emissions', preset }) },
          { title: 'Claim fees', description: 'unstaked positions', onSelect: () => app.push({ name: 'action', action: 'claim_fees', preset }) },
          { title: 'Deposit more', description: symbol, onSelect: () => app.push({ name: 'action', action: 'deposit', preset: { pool: lp } }) },
        ],
      }]
    })
  }, [data, app])
  const banner = app.wallet ? undefined : (
    <box height={1} flexShrink={0} paddingLeft={1}>
      <text fg={theme.warning}>No wallet connected — positions need one (Wallet screen)</text>
    </box>
  )
  return (
    <BrowseList
      title="Positions"
      header={`${pad('POOL', 30)} ${pad('ID', 8)} ${pad('AMOUNT0', 12)} ${pad('AMOUNT1', 12)} ${pad('STATE', 9)} EARNED`}
      rows={rows}
      loading={loading}
      error={error}
      freshness={freshness}
      reload={reload}
      empty={app.wallet ? 'No positions on this chain' : 'Connect a wallet to see positions'}
      banner={banner}
    />
  )
}

const MAX_BANNER_SLICES = 6
type VoteSlice = { value: number; color: 'green' | 'blue' | 'purple' | 'grey' }
const voteSliceColor = (index: number): VoteSlice['color'] => (index === 0 ? 'green' : index < 4 ? 'blue' : 'purple')

export function EpochsScreen() {
  const app = useApp()
  const { loading, error, data, freshness, reload } = useAction('epochs_latest', {})
  const rows = useMemo<BrowseRow[]>(() => {
    if (!Array.isArray(data)) return []
    return data
      .flatMap((entry) => {
        const epoch = jsonRecord(entry)
        const pool = epoch ? jsonRecord(epoch.pool) : undefined
        if (!epoch || !pool) return []
        const lp = jsonString(epoch.lp) ?? ''
        const symbol = jsonString(pool.symbol) ?? lp
        const line = [
          pad(symbol, 34),
          pad(formatNumber(scaled(epoch.votes)), 12),
          pad(formatNumber(scaled(epoch.emissions)), 12),
          pad(formatUsd(jsonNumber(epoch.total_fees) ?? 0), 10),
          formatUsd(jsonNumber(epoch.total_incentives) ?? 0),
        ].join(' ')
        return [{
          key: lp,
          line,
          searchText: `${symbol} ${lp}`,
          votes: scaled(epoch.votes),
          actions: [
            { title: 'Epoch history', description: symbol, onSelect: () => app.push({ name: 'action', action: 'epochs', preset: { lp } }) },
            { title: 'Deposit liquidity', description: symbol, onSelect: () => app.push({ name: 'action', action: 'deposit', preset: { pool: lp } }) },
          ],
        }]
      })
      .sort((left, right) => right.votes - left.votes)
      .map(({ votes: _votes, ...row }) => row)
  }, [data, app])
  const banner = useMemo(() => {
    if (!Array.isArray(data)) return undefined
    // SAFETY: votes arrive as 18-decimal wei strings from the API; scaled() already narrows the shape.
    const ranked = data
      .flatMap((entry) => {
        const epoch = jsonRecord(entry)
        const pool = epoch ? jsonRecord(epoch.pool) : undefined
        if (!epoch || !pool) return []
        return [{
          symbol: jsonString(pool.symbol) ?? 'pool',
          votes: scaled(epoch.votes),
        }]
      })
      .filter((item) => item.votes > 0)
      .sort((left, right) => right.votes - left.votes)
    if (ranked.length === 0) return undefined
    const top = ranked.slice(0, MAX_BANNER_SLICES)
    const rest = ranked.slice(MAX_BANNER_SLICES).reduce((sum, item) => sum + item.votes, 0)
    const slices: VoteSlice[] = [
      ...top.map((item, index) => ({ value: item.votes, color: voteSliceColor(index) })),
      ...(rest > 0 ? [{ value: rest, color: 'grey' as const }] : []),
    ]
    return (
      <box height={2} flexShrink={0} paddingLeft={1} paddingTop={0} flexDirection="column" gap={0}>
        <box flexDirection="row" height={1}>
          <DitherLines rows={[renderStackBar({ parts: slices, width: Math.min(64, slices.length * 9) })]} />
        </box>
        <Legend items={[
          ...top.map((item, index) => ({
            label: item.symbol.replace(/^CL\d+-/, '').replace(/^(v|s)AMM-/, ''),
            color: DITHER_COLORS[index === 0 ? 'green' : index < 4 ? 'blue' : 'purple'],
          })),
          ...(rest > 0 ? [{ label: `${ranked.length - top.length} more`, color: DITHER_COLORS.grey }] : []),
        ]} />
      </box>
    )
  }, [data])
  return (
    <BrowseList
      title="Voting epochs"
      header={`${pad('POOL', 34)} ${pad('VOTES', 12)} ${pad('EMISSIONS', 12)} ${pad('FEES', 10)} INCENTIVES`}
      rows={rows}
      loading={loading}
      error={error}
      freshness={freshness}
      reload={reload}
      empty="No epochs returned"
      banner={banner}
    />
  )
}
