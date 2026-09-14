import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SugarAction, SugarParameters } from '../contracts'
import { getActiveWallet, onWalletChange, type ActiveWallet } from '../wallet'
import { DEFAULT_CHAIN } from '../cli/flags'

export type Route =
  | { name: 'home' }
  | { name: 'stocks' }
  | { name: 'indices' }
  | { name: 'index_editor'; index?: import('../stocks/indices').StockIndex }
  | { name: 'pools' }
  | { name: 'positions' }
  | { name: 'epochs' }
  | { name: 'analytics' }
  | { name: 'wallet' }
  | { name: 'action'; action: SugarAction; preset?: SugarParameters }

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'
export type ToastItem = { id: number; variant: ToastVariant; title: string; message?: string }

export type DialogEntry = { id: number; node: ReactNode }

type AppState = {
  routes: Route[]
  route: Route
  push: (route: Route) => void
  pop: () => void
  replace: (route: Route) => void
  dialogs: DialogEntry[]
  openDialog: (render: (close: () => void) => ReactNode) => void
  closeDialog: () => void
  dialogOpen: boolean
  toasts: ToastItem[]
  toast: (variant: ToastVariant, title: string, message?: string) => void
  chain: number
  setChain: (chain: number) => void
  wallet: ActiveWallet | undefined
  refreshWallet: () => void
  /** True while transactions are being signed and broadcast; quitting asks twice. */
  busy: boolean
  setBusy: (busy: boolean) => void
  quit: () => void
}

const AppContext = createContext<AppState | undefined>(undefined)

export function useApp(): AppState {
  const state = useContext(AppContext)
  if (!state) throw new Error('useApp must be used inside AppProvider')
  return state
}

export function AppProvider(props: { onQuit: () => void; children: ReactNode }) {
  const [routes, setRoutes] = useState<Route[]>([{ name: 'home' }])
  const [dialogs, setDialogs] = useState<DialogEntry[]>([])
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [chain, setChain] = useState(DEFAULT_CHAIN)
  const [busy, setBusy] = useState(false)
  const [wallet, setWallet] = useState<ActiveWallet | undefined>(() => {
    try {
      return getActiveWallet()
    } catch {
      return undefined
    }
  })
  const nextId = useRef(1)

  const push = useCallback((route: Route) => setRoutes((stack) => [...stack, route]), [])
  const pop = useCallback(() => setRoutes((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)), [])
  const replace = useCallback((route: Route) => setRoutes((stack) => [...stack.slice(0, -1), route]), [])

  const closeDialog = useCallback(() => setDialogs((stack) => stack.slice(0, -1)), [])
  const openDialog = useCallback((render: (close: () => void) => ReactNode) => {
    const id = nextId.current++
    const close = () => setDialogs((stack) => stack.filter((entry) => entry.id !== id))
    setDialogs((stack) => [...stack, { id, node: render(close) }])
  }, [])

  const toast = useCallback((variant: ToastVariant, title: string, message?: string) => {
    const id = nextId.current++
    setToasts((items) => [...items, { id, variant, title, message }])
    setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 5000)
  }, [])

  const refreshWallet = useCallback(() => {
    try {
      setWallet(getActiveWallet())
    } catch {
      setWallet(undefined)
    }
  }, [])

  useEffect(() => onWalletChange(refreshWallet), [refreshWallet])

  const value = useMemo<AppState>(() => ({
    routes,
    route: routes[routes.length - 1],
    push,
    pop,
    replace,
    dialogs,
    openDialog,
    closeDialog,
    dialogOpen: dialogs.length > 0,
    toasts,
    toast,
    chain,
    setChain,
    wallet,
    refreshWallet,
    busy,
    setBusy,
    quit: props.onQuit,
  }), [routes, push, pop, replace, dialogs, openDialog, closeDialog, toasts, toast, chain, wallet, refreshWallet, busy, props.onQuit])

  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>
}
