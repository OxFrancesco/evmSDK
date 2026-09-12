import { StocksScreen, IndicesScreen, IndexEditorScreen } from './screens/stocks'
import { useKeyboard } from '@opentui/react'
import { Fragment, useEffect } from 'react'
import { SUPPORTED_CHAIN_IDS } from '../config'
import { SUGAR_ACTIONS, isSugarTxAction } from '../contracts'
import { warmChain } from './sugar'
import { SelectDialog, type SelectItem } from './dialogs'
import { ACTION_DESCRIPTIONS, ACTION_TITLES } from './fields'
import { theme } from './theme'
import { useApp } from './store'
import { ActionScreen } from './screens/action'
import { AnalyticsScreen } from './screens/analytics'
import { EpochsScreen, PoolsScreen, PositionsScreen } from './screens/browse'
import { HomeScreen } from './screens/home'
import { WalletScreen } from './screens/wallet'
import { chainLabel, Toasts } from './widgets'

export function App() {
  const app = useApp()

  const walletAddress = app.wallet?.address
  useEffect(() => {
    warmChain(app.chain, walletAddress)
  }, [app.chain, walletAddress])

  const openChainDialog = () => {
    const items: SelectItem[] = SUPPORTED_CHAIN_IDS.map((chainId) => ({
      title: chainLabel(chainId),
      description: String(chainId),
      hint: chainId === app.chain ? 'current' : undefined,
      onSelect: () => {
        app.setChain(chainId)
        app.toast('info', 'Chain switched', `${chainLabel(chainId)} (${chainId})`)
      },
    }))
    app.openDialog((close) => <SelectDialog title="Switch chain" items={items} close={close} />)
  }

  const openPalette = () => {
    const items: SelectItem[] = [
      ...SUGAR_ACTIONS.filter((action) => action !== 'stocks').map((action) => ({
        title: ACTION_TITLES[action],
        description: ACTION_DESCRIPTIONS[action],
        hint: isSugarTxAction(action) ? 'tx' : 'read',
        onSelect: () => app.push({ name: 'action', action }),
      })),
      { title: 'Stocks', onSelect: () => app.push({ name: 'stocks' }) },
      { title: 'Indices', onSelect: () => app.push({ name: 'indices' }) },
      { title: 'Pools', description: 'browse pools with TVL and gauges', onSelect: () => app.push({ name: 'pools' }) },
      { title: 'Positions', description: 'your liquidity with one-key actions', onSelect: () => app.push({ name: 'positions' }) },
      { title: 'Epochs', description: 'latest voting round per pool', onSelect: () => app.push({ name: 'epochs' }) },
      { title: 'Analytics', description: 'Dune Analytics: E/R, RPV, and Base share', onSelect: () => app.push({ name: 'analytics' }) },
      { title: 'Wallet', description: 'connect, create, restore, or remove', onSelect: () => app.push({ name: 'wallet' }) },
      { title: 'Switch chain', description: `now ${chainLabel(app.chain)} (${app.chain})`, onSelect: openChainDialog },
      { title: 'Home', description: 'back to the start screen', onSelect: () => app.push({ name: 'home' }) },
      { title: 'Quit', description: 'leave the TUI', onSelect: app.quit },
    ]
    app.openDialog((close) => <SelectDialog title="Commands" items={items} placeholder="What do you want to do?" close={close} />)
  }

  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (key.ctrl && (key.name === 'k' || key.name === 'p')) return openPalette()
    if (key.name === 'c' && app.route.name === 'home') return openChainDialog()
  })

  const route = app.route
  const screen = route.name === 'home' ? <HomeScreen openPalette={openPalette} />
    : route.name === 'stocks' ? <StocksScreen />
    : route.name === 'indices' ? <IndicesScreen />
    : route.name === 'index_editor' ? <IndexEditorScreen index={route.index} />
    : route.name === 'pools' ? <PoolsScreen />
    : route.name === 'positions' ? <PositionsScreen />
    : route.name === 'epochs' ? <EpochsScreen />
    : route.name === 'analytics' ? <AnalyticsScreen />
    : route.name === 'wallet' ? <WalletScreen />
    : <ActionScreen key={`${app.chain}:${walletAddress}:${route.action}:${JSON.stringify(route.preset ?? {})}`} action={route.action} preset={route.preset} />

  const topDialog = app.dialogs[app.dialogs.length - 1]

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      {screen}
      {topDialog ? <Fragment key={topDialog.id}>{topDialog.node}</Fragment> : null}
      <Toasts />
    </box>
  )
}
