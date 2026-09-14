import { useKeyboard } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import { formatCliError } from '../../cli'
import { STOCKS, STOCK_CHAIN } from '../../stocks/catalog'
import { PromptDialog, SelectDialog } from '../dialogs'
import { formatUsd, jsonRecord, jsonString } from '../format'
import { runTuiAction } from '../sugar'
import { useApp } from '../store'
import { theme } from '../theme'
import { ScreenFrame, Spinner } from '../widgets'
import type { SugarParameters } from '../../contracts'
import type { SugarJson } from '../../types'

type Sort = 'catalog' | 'name' | 'value'

const EMPTY = '—'

export function StocksScreen() {
  const app = useApp()
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const [data, setData] = useState<SugarJson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, refresh] = useState(0)
  const [filter, setFilter] = useState('')
  const [heldOnly, setHeldOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('catalog')
  const rows = STOCKS.map((stock) => {
    const row = data.map(jsonRecord).find((entry) => entry?.symbol === stock.symbol)
    const price = jsonString(row?.price_usdc)
    const balance = jsonString(row?.balance)
    const held = balance !== undefined && Number(balance) > 0
    return { stock, price, balance, held, value: price !== undefined && held ? Number(price) * Number(balance) : undefined, error: jsonString(row?.error) }
  }).filter(({ stock, held }) => `${stock.symbol} ${stock.name}`.toLowerCase().includes(filter.toLowerCase()) && (!heldOnly || held))
    .sort((left, right) => sort === 'name' ? left.stock.name.localeCompare(right.stock.name) : sort === 'value' ? (right.value ?? -1) - (left.value ?? -1) : 0)
  const select = (index: number) => { selectedRef.current = index; setSelected(index) }
  useEffect(() => {
    let alive = true
    setData([])
    setError('')
    setLoading(app.chain === STOCK_CHAIN)
    if (app.chain !== STOCK_CHAIN) return
    const parameters: SugarParameters = { chain: app.chain }
    if (app.wallet) parameters.wallet = app.wallet.address
    void runTuiAction('stocks', parameters, { fresh: true }).then((result) => {
      if (alive && Array.isArray(result)) setData(result)
    }).catch((cause) => { if (alive) setError(formatCliError(cause)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [app.chain, app.wallet?.address, revision])
  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') return app.pop()
    if (key.ctrl && key.name === 'r') return refresh((value) => value + 1)
    if (key.name === '/') return app.openDialog((close) => <PromptDialog title="Search stocks" placeholder="Symbol or company, empty clears" close={close} onSubmit={(value) => { setFilter(value.trim()); select(0) }} />)
    if (key.name === 'h') {
      if (!app.wallet) return app.toast('info', 'Connect a wallet', 'Open Wallet to see your stock holdings')
      setHeldOnly((value) => !value)
      return select(0)
    }
    if (key.name === 'o') return app.openDialog((close) => <SelectDialog title="Sort stocks" close={close} items={[
      { title: 'Catalog order', onSelect: () => { setSort('catalog'); select(0) } },
      { title: 'Company name', onSelect: () => { setSort('name'); select(0) } },
      { title: 'Holding value, largest first', onSelect: () => { setSort('value'); select(0) } },
    ]} />)
    if (app.chain !== STOCK_CHAIN) {
      if (key.name === 'return') app.setChain(STOCK_CHAIN)
      return
    }
    if (key.name === 'up' || key.name === 'down') {
      if (rows.length === 0) return
      return select((selectedRef.current + (key.name === 'down' ? 1 : rows.length - 1)) % rows.length)
    }
    const row = rows[Math.min(selectedRef.current, rows.length - 1)]
    if (row && (key.name === 'b' || key.name === 's' || key.name === 'return')) app.push({ name: 'action', action: key.name === 's' ? 'stock_sell' : 'stock_buy', preset: { stock: row.stock.symbol } })
  })
  const active = Math.min(selected, rows.length - 1)
  const current = rows[active]
  const hints = [
    { key: '↑↓', label: 'move' },
    { key: 'b/s', label: 'buy/sell' },
    { key: 'h', label: heldOnly ? 'all stocks' : 'holdings' },
    { key: 'o', label: 'sort' },
    { key: '/', label: 'find' },
    { key: 'ctrl+r', label: 'refresh' },
    { key: 'esc', label: 'back' },
  ]
  return <ScreenFrame title="Stocks" hints={hints}>
    {app.chain !== STOCK_CHAIN ? <text fg={theme.warning}>Stocks trade on Base. Press Enter to switch.</text> : <>
      {filter ? <box height={1}><text fg={theme.textMuted}>Search: {filter}</text></box> : null}
      <box height={1}>
        <text fg={theme.textMuted}>{'Stock'.padEnd(9)}{'Company'.padEnd(12)}{'USDC / token'.padStart(14)}{'Held'.padStart(14)}{'Est. USDC'.padStart(13)}</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0}>
        {rows.map(({ stock, price, balance, held, value }, index) => (
          <box key={stock.symbol} height={1} backgroundColor={active === index ? theme.backgroundElement : undefined}>
            <text fg={active === index ? theme.primary : theme.text}>
              {stock.symbol.padEnd(9)}
              {stock.name.padEnd(12)}
              {(price ? Number(price).toFixed(2) : EMPTY).padStart(14)}
              {(held && balance ? Number(balance).toLocaleString('en-US', { maximumFractionDigits: 6 }) : EMPTY).padStart(14)}
              {(value === undefined ? EMPTY : formatUsd(value)).padStart(13)}
            </text>
          </box>
        ))}
        {rows.length === 0 && !loading ? <text fg={theme.textMuted}>{heldOnly ? 'No matching holdings. Press h to show all stocks.' : 'No matching stocks. Press / to change the search.'}</text> : null}
      </scrollbox>
      {loading ? <Spinner label="Loading stock quotes and balances" activity /> : null}
      {error || current?.error ? <text fg={theme.error}>{error || current?.error}</text> : null}
    </>}
  </ScreenFrame>
}

export { IndicesScreen, IndexEditorScreen } from './indices'
