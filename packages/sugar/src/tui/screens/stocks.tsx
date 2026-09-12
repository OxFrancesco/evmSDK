import { useKeyboard } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import { formatCliError } from '../../cli'
import { STOCKS, STOCK_CHAIN, parseAllocations } from '../../stocks/catalog'
import { deleteIndex, listIndices, saveIndex, type StockIndex } from '../../stocks/indices'
import { PromptDialog, SelectDialog } from '../dialogs'
import { jsonRecord, jsonString } from '../format'
import { runTuiAction } from '../sugar'
import { useApp } from '../store'
import { theme } from '../theme'
import { ScreenFrame, Spinner } from '../widgets'
import type { SugarParameters } from '../../contracts'
import type { SugarJson } from '../../types'

export function StocksScreen() {
  const app = useApp()
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const [data, setData] = useState<SugarJson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, refresh] = useState(0)
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
    if (key.name === 'i') return app.push({ name: 'indices' })
    if (key.name === 'r') return refresh((value) => value + 1)
    if (app.chain !== STOCK_CHAIN) {
      if (key.name === 'return') app.setChain(STOCK_CHAIN)
      return
    }
    if (key.name === 'up' || key.name === 'down') {
      selectedRef.current = (selectedRef.current + (key.name === 'down' ? 1 : STOCKS.length - 1)) % STOCKS.length
      return setSelected(selectedRef.current)
    }
    if (key.name === 'b' || key.name === 's' || key.name === 'return') app.push({ name: 'action', action: key.name === 's' ? 'stock_sell' : 'stock_buy', preset: { stock: STOCKS[selectedRef.current].symbol } })
  })
  const current = jsonRecord(data[selected])
  return <ScreenFrame title="Stocks" hints={[{ key: '↑↓', label: 'stock' }, { key: 'b', label: 'buy' }, { key: 's', label: 'sell' }, { key: 'i', label: 'indices' }, { key: 'r', label: 'refresh' }, { key: 'esc', label: 'back' }]}>
    {app.chain !== STOCK_CHAIN ? <text fg={theme.warning}>Stocks trade on Base. Press Enter to switch.</text> : <>
      <text fg={theme.textMuted}>{'Stock'.padEnd(10)}{'Company'.padEnd(18)}{'USDC / token'.padStart(15)}{'Held'.padStart(18)}</text>
      <scrollbox flexGrow={1} minHeight={0}>
        {STOCKS.map((stock, index) => {
          const row = jsonRecord(data[index])
          const price = jsonString(row?.price_usdc)
          const balance = jsonString(row?.balance)
          return <box key={stock.symbol} height={1} backgroundColor={selected === index ? theme.backgroundElement : undefined}>
            <text fg={selected === index ? theme.primary : theme.text}>{stock.symbol.padEnd(10)}{stock.name.padEnd(18)}{(price ? Number(price).toFixed(2) : '—').padStart(15)}{(balance ? Number(balance).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—').padStart(18)}</text>
          </box>
        })}
      </scrollbox>
      {loading ? <Spinner label="Loading stock quotes and balances" activity /> : null}
      {error || jsonString(current?.error) ? <text fg={theme.error}>{error || jsonString(current?.error)}</text> : null}
    </>}
  </ScreenFrame>
}

export function IndicesScreen() {
  const app = useApp()
  const [indices, setIndices] = useState<StockIndex[]>([])
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const reload = () => {
    try { setIndices(listIndices()); selectedRef.current = 0; setSelected(0) }
    catch (cause) { app.toast('error', 'Cannot read indices', formatCliError(cause)) }
  }
  useEffect(reload, [])
  const current = indices[selected]
  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') return app.pop()
    if (key.name === 'n') return app.push({ name: 'index_editor' })
    const item = indices[selectedRef.current]
    if (!item) return
    if (key.name === 'up' || key.name === 'down') {
      selectedRef.current = (selectedRef.current + (key.name === 'down' ? 1 : indices.length - 1)) % indices.length
      return setSelected(selectedRef.current)
    }
    if (key.name === 'e') return app.push({ name: 'index_editor', index: item })
    if (key.name === 'return' || key.name === 'r') {
      app.setChain(STOCK_CHAIN)
      return app.push({ name: 'action', action: 'index_rebalance', preset: { allocations: item.allocations } })
    }
    if (key.name === 'd') app.openDialog((close) => <SelectDialog title={`Delete ${item.name}?`} close={close} items={[
      { title: 'Cancel', onSelect: () => {} },
      { title: 'Delete saved weights', description: 'Wallet holdings stay unchanged', onSelect: () => { try { deleteIndex(item.name); reload() } catch (cause) { app.toast('error', 'Delete failed', formatCliError(cause)) } } },
    ]} />)
  })
  return <ScreenFrame title="Indices" hints={[{ key: 'n', label: 'create' }, { key: 'e', label: 'edit' }, { key: 'r', label: 'rebalance' }, { key: 'd', label: 'delete' }, { key: 'esc', label: 'back' }]}>
    {indices.length === 0 ? <text fg={theme.textMuted}>No saved indices. Press n to choose stocks and weights.</text> : null}
    {indices.map((item, index) => <text key={item.name} fg={selected === index ? theme.primary : theme.text}>{selected === index ? '› ' : '  '}{item.name}</text>)}
    <box height={1} />
    {current ? parseAllocations(current.allocations).map(({ stock, weightBps }) => <text key={stock.symbol} fg={theme.text}>{stock.symbol.padEnd(10)}<span fg={theme.primary}>{'━'.repeat(Math.round(weightBps / 400)).padEnd(25)}</span>{String(weightBps / 100).padStart(6)}%</text>) : null}
  </ScreenFrame>
}

export function IndexEditorScreen(props: { index?: StockIndex }) {
  const app = useApp()
  const [name, setName] = useState(props.index?.name ?? '')
  const [weights, setWeights] = useState(() => new Map(parseAllocations(props.index?.allocations ?? 'NVDAc=100').map(({ stock, weightBps }) => [stock.symbol, props.index ? weightBps : 0])))
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') return app.pop()
    if (key.name === 'up' || key.name === 'down') {
      selectedRef.current = (selectedRef.current + (key.name === 'down' ? 1 : STOCKS.length)) % (STOCKS.length + 1)
      return setSelected(selectedRef.current)
    }
    if (key.name === 's') {
      try {
        const original = new Set(props.index ? parseAllocations(props.index.allocations).map(({ stock }) => stock.symbol) : [])
        const allocations = STOCKS.filter((stock) => (weights.get(stock.symbol) ?? 0) > 0 || original.has(stock.symbol)).map((stock) => `${stock.symbol}=${(weights.get(stock.symbol) ?? 0) / 100}`).join(',')
        saveIndex(name, allocations, props.index !== undefined)
        app.toast('success', 'Index saved', name)
        app.pop()
      } catch (cause) { app.toast('error', 'Cannot save index', formatCliError(cause)) }
      return
    }
    if (key.name !== 'return') return
    if (selectedRef.current === 0) {
      if (props.index) return
      return app.openDialog((close) => <PromptDialog title="Index name" placeholder="my-index" close={close} onSubmit={setName} />)
    }
    const stock = STOCKS[selectedRef.current - 1]
    app.openDialog((close) => <PromptDialog title={`${stock.symbol} weight %`} placeholder="0 to 100" close={close} onSubmit={(value) => {
      if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) > 100) return app.toast('error', 'Invalid weight', 'Use 0 to 100, with up to two decimal places')
      setWeights((current) => new Map(current).set(stock.symbol, Math.round(Number(value) * 100)))
    }} />)
  })
  return <ScreenFrame title={props.index ? 'Edit index' : 'Create index'} hints={[{ key: '↑↓', label: 'field' }, { key: 'enter', label: 'edit' }, { key: 's', label: 'save' }, { key: 'esc', label: 'cancel' }]}>
    <text fg={selected === 0 ? theme.primary : theme.text}>Name  {name || 'Press Enter to name your index'}</text>
    <box height={1} />
    <scrollbox flexGrow={1} minHeight={0}>
      {STOCKS.map((stock, index) => <box key={stock.symbol} height={1} backgroundColor={selected === index + 1 ? theme.backgroundElement : undefined}>
        <text fg={selected === index + 1 ? theme.primary : theme.text}>{stock.symbol.padEnd(10)}<span fg={theme.primary}>{'━'.repeat(Math.round((weights.get(stock.symbol) ?? 0) / 400)).padEnd(25)}</span>{String((weights.get(stock.symbol) ?? 0) / 100).padStart(6)}%</text>
      </box>)}
    </scrollbox>
    <text fg={total === 10000 ? theme.success : theme.warning}>Allocated {total / 100}% / 100%</text>
  </ScreenFrame>
}
