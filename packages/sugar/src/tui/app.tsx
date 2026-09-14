import { StocksScreen, IndicesScreen, IndexEditorScreen } from './screens/stocks'
import { useKeyboard } from '@opentui/react'
import { Fragment, useEffect, useRef } from 'react'
import { SUPPORTED_CHAIN_IDS } from '../config'
import { SUGAR_ACTIONS, isSugarTxAction } from '../contracts'
import { warmChain } from './sugar'
import { SelectDialog, type SelectItem } from './dialogs'
import { actionDescription, actionTitle } from './fields'
import { theme } from './theme'
import { useApp, type Route } from './store'
import { ActionScreen } from './screens/action'
import { AnalyticsScreen } from './screens/analytics'
import { EpochsScreen, PoolsScreen, PositionsScreen } from './screens/browse'
import { HOME_MENU, HomeScreen } from './screens/home'
import { WalletScreen } from './screens/wallet'
import { chainLabel, Toasts } from './widgets'

/** Second ctrl+c within this window quits even while a broadcast is running. */
const FORCE_QUIT_WINDOW_MS = 3000

/** Actions the home menu already routes to, so the palette lists only the rest. */
function routedActions(): Set<string> {
  return new Set(HOME_MENU.flatMap((item) => (item.route.name === 'action' ? [item.route.action] : [])))
}

/** `stocks` is a screen of its own; its action form has no fields. */
const PALETTE_HIDDEN = new Set<string>(['stocks'])

export function App() {
  const app = useApp()
  const quitArmedAt = useRef(0)

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
    const routed = routedActions()
    const items: SelectItem[] = [
      ...HOME_MENU.map((item) => ({ title: item.title, description: item.description, onSelect: () => app.push(item.route) })),
      ...SUGAR_ACTIONS.filter((action) => !routed.has(action) && !PALETTE_HIDDEN.has(action)).map((action) => ({
        title: actionTitle(action),
        description: actionDescription(action),
        hint: isSugarTxAction(action) ? 'tx' : 'read',
        onSelect: () => app.push({ name: 'action', action }),
      })),
      { title: 'Switch chain', description: `now ${chainLabel(app.chain)} (${app.chain})`, onSelect: openChainDialog },
      { title: 'Home', description: 'back to the start screen', onSelect: () => app.push({ name: 'home' }) },
      { title: 'Quit', description: 'leave the TUI', onSelect: app.quit },
    ]
    app.openDialog((close) => <SelectDialog title="Commands" items={items} placeholder="What do you want to do?" close={close} />)
  }

  const quit = () => {
    const now = Date.now()
    if (app.busy && now - quitArmedAt.current > FORCE_QUIT_WINDOW_MS) {
      quitArmedAt.current = now
      return app.toast('warning', 'Broadcast in progress', 'Press ctrl+c again within 3s to quit anyway')
    }
    app.quit()
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') return quit()
    if (app.dialogOpen) return
    if (key.ctrl && (key.name === 'k' || key.name === 'p')) return openPalette()
    if (key.name === 'c' && app.route.name === 'home') return openChainDialog()
  })

  const route: Route = app.route
  const screen = route.name === 'home' ? <HomeScreen />
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
