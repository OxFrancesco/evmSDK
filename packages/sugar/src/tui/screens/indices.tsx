import { useKeyboard } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'
import { formatCliError } from '../../cli'
import { STOCKS, STOCK_CHAIN, parseAllocations } from '../../stocks/catalog'
import { deleteIndex, listIndices, saveIndex, type StockIndex } from '../../stocks/indices'
import { ConfirmDialog, PromptDialog } from '../dialogs'
import { equalWeights, indexAllocations } from '../index-weights'
import { useApp } from '../store'
import { theme } from '../theme'
import { ScreenFrame } from '../widgets'

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
    if (key.name === 'return') return app.push({ name: 'index_editor', index: item })
    if (key.name === 'r') {
      app.setChain(STOCK_CHAIN)
      return app.push({ name: 'action', action: 'index_rebalance', preset: { allocations: item.allocations } })
    }
    if (key.name === 'd') app.openDialog((close) => (
      <ConfirmDialog
        title={`Delete ${item.name}?`}
        message="Only the saved weights are deleted. Wallet holdings stay unchanged."
        confirmLabel="Delete"
        danger
        close={close}
        onConfirm={() => { try { deleteIndex(item.name); reload() } catch (cause) { app.toast('error', 'Delete failed', formatCliError(cause)) } }}
      />
    ))
  })
  return <ScreenFrame title="Indices" hints={[{ key: '↑↓', label: 'index' }, { key: 'enter', label: 'edit' }, { key: 'r', label: 'rebalance' }, { key: 'n', label: 'new' }, { key: 'd', label: 'delete' }, { key: 'esc', label: 'back' }]}>
    {indices.length === 0 ? <text fg={theme.textMuted}>No saved indices. Press n to choose stocks and weights.</text> : null}
    {indices.map((item, index) => (
      <box key={item.name} height={1}>
        <text fg={selected === index ? theme.primary : theme.text}>{selected === index ? '› ' : '  '}{item.name}</text>
      </box>
    ))}
    <box height={1} />
    {current ? parseAllocations(current.allocations).map(({ stock, weightBps }) => (
      <box key={stock.symbol} height={1}>
        <text fg={theme.text}>{stock.symbol.padEnd(10)}<span fg={theme.primary}>{'━'.repeat(Math.round(weightBps / 400)).padEnd(25)}</span>{String(weightBps / 100).padStart(6)}%</text>
      </box>
    )) : null}
  </ScreenFrame>
}

export function IndexEditorScreen(props: { index?: StockIndex }) {
  const app = useApp()
  const [name, setName] = useState(props.index?.name ?? '')
  const [weights, setWeights] = useState(() => new Map(props.index ? parseAllocations(props.index.allocations).map(({ stock, weightBps }) => [stock.symbol, weightBps]) : []))
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
  const originalSymbols = new Set(props.index ? parseAllocations(props.index.allocations).map(({ stock }) => stock.symbol) : [])
  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.name === 'escape') return app.pop()
    if (key.name === 'up' || key.name === 'down') {
      selectedRef.current = (selectedRef.current + (key.name === 'down' ? 1 : STOCKS.length)) % (STOCKS.length + 1)
      return setSelected(selectedRef.current)
    }
    if (key.name === 's' || key.name === 'r') {
      try {
        const saved = saveIndex(name.trim(), indexAllocations(weights, props.index?.allocations), props.index !== undefined)
        app.toast('success', 'Index saved', name)
        if (key.name === 'r') {
          app.setChain(STOCK_CHAIN)
          app.replace({ name: 'action', action: 'index_rebalance', preset: { allocations: saved.allocations } })
        } else app.pop()
      } catch (cause) { app.toast('error', 'Cannot save index', formatCliError(cause)) }
      return
    }
    if (key.name === 'e') {
      try { setWeights(equalWeights(weights)) }
      catch (cause) { app.toast('error', 'Cannot split weights', formatCliError(cause)) }
      return
    }
    const selectedStock = STOCKS[selectedRef.current - 1]
    if (selectedStock && ['left', 'right', 'space', 'f'].includes(key.name)) {
      setWeights((current) => {
        const next = new Map(current)
        const weight = next.get(selectedStock.symbol) ?? 0
        if (key.name === 'space') {
          if (next.has(selectedStock.symbol)) next.delete(selectedStock.symbol)
          else next.set(selectedStock.symbol, 100)
        } else if (key.name === 'f') {
          const others = [...next].reduce((sum, [symbol, value]) => sum + (symbol === selectedStock.symbol ? 0 : value), 0)
          next.set(selectedStock.symbol, Math.max(0, 10000 - others))
        } else next.set(selectedStock.symbol, Math.min(10000, Math.max(0, weight + (key.name === 'right' ? 100 : -100))))
        return next
      })
      return
    }
    if (key.name !== 'return') return
    if (selectedRef.current === 0) {
      if (props.index) return
      return app.openDialog((close) => <PromptDialog title="Index name" placeholder="my-index" close={close} onSubmit={setName} />)
    }
    const stock = STOCKS[selectedRef.current - 1]
    app.openDialog((close) => <PromptDialog title={`${stock.symbol} weight %`} label={`Current ${(weights.get(stock.symbol) ?? 0) / 100}%. Enter 0 to sell this holding when rebalancing.`} placeholder="0 to 100" close={close} onSubmit={(value) => {
      if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) > 100) return app.toast('error', 'Invalid weight', 'Use 0 to 100, with up to two decimal places')
      setWeights((current) => new Map(current).set(stock.symbol, Math.round(Number(value) * 100)))
    }} />)
  })
  return <ScreenFrame title={props.index ? 'Edit index' : 'Create index'} hints={[{ key: '↑↓', label: 'field' }, { key: 'enter', label: 'edit' }, { key: 's', label: 'save' }, { key: 'r', label: 'save & rebalance' }, { key: 'esc', label: 'cancel' }]}>
    <text fg={selected === 0 ? theme.primary : theme.text}>Name  {name || 'Press Enter to name your index'}</text>
    <box height={1} />
    <scrollbox flexGrow={1} minHeight={0}>
      {STOCKS.map((stock, index) => <box key={stock.symbol} height={1} backgroundColor={selected === index + 1 ? theme.backgroundElement : undefined}>
        <text fg={selected === index + 1 ? theme.primary : theme.text}>{stock.symbol.padEnd(9)}{stock.name.padEnd(12)}<span fg={theme.primary}>{'━'.repeat(Math.round((weights.get(stock.symbol) ?? 0) / 500)).padEnd(20)}</span>{String((weights.get(stock.symbol) ?? 0) / 100).padStart(6)}%{(weights.get(stock.symbol) ?? 0) === 0 && (weights.has(stock.symbol) || originalSymbols.has(stock.symbol)) ? ' exit' : ''}</text>
      </box>)}
    </scrollbox>
    <box height={1}><text fg={theme.textMuted}>space include · ←→ 1% · e equal weights · f fill remaining</text></box>
    <box height={1}><text fg={total === 10000 ? theme.success : theme.warning}>Allocated {total / 100}% / 100%{total < 10000 ? ` · ${(10000 - total) / 100}% remaining` : total > 10000 ? ` · ${(total - 10000) / 100}% over` : ''}</text></box>
  </ScreenFrame>
}
