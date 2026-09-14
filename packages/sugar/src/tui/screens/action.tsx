import { TextAttributes } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatCliError } from '../../cli'
import { isSugarTxAction, type SugarAction, type SugarParameters } from '../../contracts'
import { acceptsWallet } from '../../action-schema'
import { toTokenChoice } from '../../token-catalog'
import { createExecutionPlan, extractPlanSteps, localMnemonicSigner, renderPlanSummary, sendPlan, type ExecutionPlan, type PlanSigner, type PlanStep } from '../../send'
import type { SugarJson, Token } from '../../types'
import { loadLocalWallet, openSecret } from '../../wallet'
import { externalWalletSigner } from '../../external-wallet-signer'
import { SelectDialog, PromptDialog, type SelectItem } from '../dialogs'
import { ANY, actionFields, actionTitle, buildParameters, initialValues, POOL_IS_CL, visibleFields, type FieldSpec, type FormValues } from '../fields'
import { formatNumber, formatUsd, jsonNumber, jsonRecord, jsonString } from '../format'
import { humanizeResult } from '../humanize'
import { clearTuiPrefetch, POOLS_BROWSE_PARAMETERS, runTuiAction, tuiTokenCatalog } from '../sugar'
import { theme } from '../theme'
import { useApp } from '../store'
import { ScreenFrame, Spinner } from '../widgets'

type Plan = { result: SugarJson; steps: PlanStep[]; summary: string; execution: ExecutionPlan }
type Phase =
  | { kind: 'form' }
  | { kind: 'running'; label: string }
  | { kind: 'result'; data: SugarJson; showJson: boolean }
  | { kind: 'plan'; plan: Plan; showJson: boolean }
  | { kind: 'broadcast' }
  | { kind: 'sent'; hashes: string[] }

const ENTER = new Set(['return', 'enter', 'linefeed'])

function presetValues(fields: FieldSpec[], preset?: SugarParameters): FormValues {
  const values = initialValues(fields)
  for (const field of fields) {
    const value = preset?.[field.name]
    if (value === undefined) continue
    values[field.name] = field.kind === 'boolean' ? value === true : String(value)
  }
  return values
}

const scaled = (value: SugarJson | undefined, decimals = 18): number => {
  const raw = jsonString(value) ?? (jsonNumber(value) === undefined ? undefined : String(jsonNumber(value)))
  return raw === undefined ? 0 : Number(raw) / 10 ** decimals
}

function FieldRow(props: { field: FieldSpec; value: string | boolean; active: boolean; editable: boolean; onInput: (value: string) => void }) {
  const { field, value, active } = props
  const label = `${field.label}${field.required ? ' *' : ''}`
  return (
    <box height={1} flexDirection="row" backgroundColor={active ? theme.backgroundElement : undefined}>
      <box width={18} paddingLeft={1} flexShrink={0}>
        <text fg={active ? theme.primary : theme.textMuted}>{label}</text>
      </box>
      <box flexGrow={1}>
        {field.kind === 'boolean' ? (
          <text fg={value === true ? theme.success : theme.textMuted}>{value === true ? '● on' : '○ off'}</text>
        ) : field.kind === 'choice' ? (
          <text fg={active ? theme.text : theme.textMuted}>{active ? `◂ ${String(value)} ▸` : String(value)}</text>
        ) : active && props.editable ? (
          <input
            focused
            value={String(value)}
            placeholder={field.placeholder}
            onInput={props.onInput}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
          />
        ) : String(value) !== '' ? (
          <text fg={theme.text}>{String(value)}</text>
        ) : (
          <text fg={theme.textMuted}>{field.placeholder ?? ''}</text>
        )}
      </box>
    </box>
  )
}

function LinesView(props: { lines: string[]; focused: boolean; mutedFirst?: boolean }) {
  return (
    <scrollbox focused={props.focused} flexGrow={1} minHeight={0}>
      {props.lines.map((line, index) => (
        <text key={index} fg={props.mutedFirst && index === 0 ? theme.textMuted : theme.text} wrapMode="none" selectable>
          {line === '' ? ' ' : line}
        </text>
      ))}
    </scrollbox>
  )
}

function JsonView(props: { data: SugarJson; focused: boolean }) {
  const lines = useMemo(() => JSON.stringify(props.data, null, 2).split('\n'), [props.data])
  return <LinesView lines={lines} focused={props.focused} />
}

function HumanResultView(props: { action: SugarAction; data: SugarJson; focused: boolean }) {
  const result = useMemo(() => humanizeResult(props.action, props.data), [props.action, props.data])
  return <LinesView lines={result.lines} focused={props.focused} mutedFirst={result.hasHeader} />
}

/** Enter-hint for the active row: what pressing Enter does here. */
function enterLabel(field: FieldSpec | undefined, last: boolean, tx: boolean): string {
  if (field?.kind === 'token') return 'browse tokens'
  if (field?.picker === 'position') return 'pick position'
  if (field?.picker === 'pool') return 'pick pool'
  if (!last) return 'next'
  return tx ? 'build plan' : 'run'
}

export function ActionScreen(props: { action: SugarAction; preset?: SugarParameters }) {
  const app = useApp()
  const allFields = useMemo(() => actionFields(props.action), [props.action])
  const [values, setValues] = useState<FormValues>(() => presetValues(allFields, props.preset))
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [log, setLog] = useState<string[]>([])
  const [catalog, setCatalog] = useState<Token[] | null>(null)
  const catalogRequest = useRef<Promise<Token[]> | null>(null)
  const pickerPending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const loadCatalog = useCallback(() => {
    if (catalogRequest.current) return catalogRequest.current
    const pending = tuiTokenCatalog(app.chain)
    catalogRequest.current = pending
    void pending.then((tokens) => {
      if (alive.current) setCatalog(tokens)
    }).catch(() => undefined).finally(() => {
      if (catalogRequest.current === pending) catalogRequest.current = null
    })
    return pending
  }, [app.chain])
  const needsCatalog = allFields.some((entry) => entry.kind === 'token')
  useEffect(() => {
    if (needsCatalog) void loadCatalog().catch(() => undefined)
  }, [loadCatalog, needsCatalog])
  const title = actionTitle(props.action)
  const isTx = isSugarTxAction(props.action)
  const fields = visibleFields(allFields, values)
  const at = Math.min(index, fields.length - 1)
  const field = fields[at]
  const setBusy = app.setBusy
  useEffect(() => {
    setBusy(phase.kind === 'broadcast')
    return () => setBusy(false)
  }, [setBusy, phase.kind])

  const setValue = (name: string, value: string | boolean) => setValues((current) => ({ ...current, [name]: value }))
  const patch = (next: FormValues) => setValues((current) => ({ ...current, ...next }))

  const showTokenPicker = (tokenField: FieldSpec, tokens: Token[]) => {
    app.openDialog((close) => (
      <SelectDialog
        title={`Select ${tokenField.label.toLowerCase()}`}
        items={tokens.map((token) => {
          const choice = toTokenChoice(token)
          return {
            id: `${token.tokenAddress}:${token.symbol}`,
            title: choice.title,
            description: choice.description,
            searchText: token.tokenAddress,
            // Ambiguous symbols fall back to the address so the picked
            // token is the one that gets swapped.
            onSelect: () => setValue(tokenField.name, token.tokenAddress),
          }
        })}
        initialFilter={String(values[tokenField.name])}
        empty="No tokens loaded for this chain"
        close={close}
      />
    ))
  }

  const openTokenPicker = (tokenField: FieldSpec) => {
    if (catalog) return showTokenPicker(tokenField, catalog)
    if (pickerPending.current) return
    pickerPending.current = true
    app.toast('info', 'Loading tokens', 'The picker will open when the catalog is ready')
    void loadCatalog().then((tokens) => {
      if (alive.current) showTokenPicker(tokenField, tokens)
    }).catch((cause: unknown) => {
      if (alive.current) app.toast('error', 'Token loading failed', `${formatCliError(cause)}. Press Enter to retry`)
    }).finally(() => { pickerPending.current = false })
  }

  /** Pick one of the wallet's positions; fills pool and position together. */
  const openPositionPicker = async () => {
    if (!app.wallet) return app.toast('error', 'No wallet', 'Connect a wallet to pick from your positions (Wallet screen)')
    if (pickerPending.current) return
    pickerPending.current = true
    try {
      const data = await runTuiAction('positions', { chain: app.chain, wallet: app.wallet.address })
      if (!alive.current) return
      const items: SelectItem[] = (Array.isArray(data) ? data : []).flatMap((entry) => {
        const position = jsonRecord(entry)
        const pool = position ? jsonRecord(position.pool) : undefined
        if (!position || !pool) return []
        const id = jsonString(position.id) ?? String(jsonNumber(position.id) ?? '')
        const lp = jsonString(pool.lp) ?? ''
        const token0 = jsonRecord(pool.token0)
        const token1 = jsonRecord(pool.token1)
        const amount0 = scaled(position.amount_token0, jsonNumber(token0?.decimals) ?? 18) + scaled(position.staked_token0, jsonNumber(token0?.decimals) ?? 18)
        const amount1 = scaled(position.amount_token1, jsonNumber(token1?.decimals) ?? 18) + scaled(position.staked_token1, jsonNumber(token1?.decimals) ?? 18)
        const staked = scaled(position.staked, 0) > 0 ? 'staked' : 'unstaked'
        return [{
          id: `${lp}:${id}`,
          title: `${jsonString(pool.symbol) ?? lp} #${id}`,
          description: `${formatNumber(amount0)} / ${formatNumber(amount1)} · ${staked}`,
          searchText: `${lp} ${staked}`,
          onSelect: () => patch({ pool: lp, position: id }),
        }]
      })
      app.openDialog((close) => <SelectDialog title="Your positions" items={items} empty="No positions on this chain" close={close} />)
    } catch (cause) {
      if (alive.current) app.toast('error', 'Positions failed to load', formatCliError(cause))
    } finally {
      pickerPending.current = false
    }
  }

  /** Pick any pool on the chain; for deposits this replaces the token-pair description. */
  const openPoolPicker = async (poolField: FieldSpec) => {
    if (pickerPending.current) return
    pickerPending.current = true
    try {
      const data = await runTuiAction('pools', { chain: app.chain, ...POOLS_BROWSE_PARAMETERS })
      if (!alive.current) return
      const items: SelectItem[] = (Array.isArray(data) ? data : []).flatMap((entry) => {
        const pool = jsonRecord(entry)
        if (!pool) return []
        const lp = jsonString(pool.lp) ?? ''
        const tvl = jsonNumber(pool.tvl)
        return [{
          id: lp,
          title: jsonString(pool.symbol) ?? lp,
          description: `${jsonString(pool.type_label) ?? ''}${tvl === undefined ? '' : ` · ${formatUsd(tvl)}`}`,
          searchText: lp,
          onSelect: () => patch(
            props.action === 'deposit'
              ? { [poolField.name]: lp, [POOL_IS_CL]: pool.is_cl === true, token0: '', token1: '', pool_type: ANY }
              : { [poolField.name]: lp },
          ),
        }]
      })
      app.openDialog((close) => <SelectDialog title="Pools" items={items} empty="No pools loaded for this chain" close={close} />)
    } catch (cause) {
      if (alive.current) app.toast('error', 'Pools failed to load', formatCliError(cause))
    } finally {
      pickerPending.current = false
    }
  }

  const cycleChoice = (step: number) => {
    if (!field?.choices) return
    const choices = field.choices
    const current = choices.indexOf(String(values[field.name]))
    setValue(field.name, choices[(current + step + choices.length) % choices.length])
  }

  const run = async () => {
    let parameters: SugarParameters
    try {
      parameters = buildParameters(fields, values, app.chain)
    } catch (cause) {
      return app.toast('error', 'Invalid input', formatCliError(cause))
    }
    if (acceptsWallet(props.action) && parameters.wallet === undefined && app.wallet) {
      parameters.wallet = app.wallet.address
    }
    if (isTx && parameters.wallet === undefined) {
      return app.toast('error', 'No wallet', 'Connect or create a wallet first (Wallet screen)')
    }
    const rerun = phase.kind === 'result'
    setPhase({ kind: 'running', label: isTx ? 'Building the transaction plan...' : 'Fetching...' })
    try {
      const result = await runTuiAction(props.action, parameters, { fresh: rerun })
      if (!alive.current) return
      if (isSugarTxAction(props.action)) {
        const steps = extractPlanSteps(result)
        if (steps.length === 0) {
          setPhase({ kind: 'result', data: result, showJson: false })
          return
        }
        if (!app.wallet) throw new Error('Wallet disconnected while building the plan')
        const execution = createExecutionPlan({ steps, chainId: Number(parameters.chain), sender: app.wallet.address })
        setPhase({ kind: 'plan', plan: { result, steps, execution, summary: renderPlanSummary(props.action, result, steps) }, showJson: false })
      } else {
        setPhase({ kind: 'result', data: result, showJson: false })
      }
    } catch (cause) {
      if (!alive.current) return
      app.toast('error', `${title} failed`, formatCliError(cause))
      setPhase({ kind: 'form' })
    }
  }

  const broadcast = async (signer: PlanSigner, plan: Plan) => {
    if (plan.execution.chainId !== app.chain || plan.execution.sender.toLowerCase() !== app.wallet?.address.toLowerCase()) {
      return app.toast('error', 'Plan invalidated', 'Rebuild the plan for the current chain and wallet')
    }
    setLog([])
    setPhase({ kind: 'broadcast' })
    const append = (line: string) => { if (alive.current) setLog((lines) => [...lines, line]) }
    try {
      const hashes = await sendPlan({ plan: plan.execution, signer, log: append })
      await clearTuiPrefetch()
      if (!alive.current) return
      app.toast('success', 'Broadcast complete', `${hashes.length} transaction${hashes.length === 1 ? '' : 's'} confirmed`)
      setPhase({ kind: 'sent', hashes })
    } catch (cause) {
      if (!alive.current) return
      app.toast('error', 'Broadcast failed', formatCliError(cause))
      setPhase({ kind: 'plan', plan, showJson: false })
    }
  }

  const sign = (plan: Plan) => {
    const external = externalWalletSigner((line) => setLog((lines) => [...lines, line]))
    if (external) return void broadcast(external, plan)
    const local = loadLocalWallet()
    if (!local) return app.toast('error', 'No wallet', 'Connect or create a wallet first (Wallet screen)')
    app.openDialog((close) => (
      <PromptDialog
        title="Wallet passphrase"
        label={`Unlock ${local.address}`}
        mask
        close={close}
        onSubmit={(passphrase) => {
          try {
            void broadcast(localMnemonicSigner(openSecret(local.sealed, passphrase)), plan)
          } catch (cause) {
            app.toast('error', 'Unlock failed', formatCliError(cause))
          }
        }}
      />
    ))
  }

  const activate = () => {
    if (field?.kind === 'token') return openTokenPicker(field)
    if (field?.picker === 'position') return void openPositionPicker()
    if (field?.picker === 'pool') return void openPoolPicker(field)
    if (at < fields.length - 1) return setIndex(at + 1)
    return void run()
  }

  useKeyboard((key) => {
    if (app.dialogOpen) return
    if (phase.kind === 'form') {
      if (key.name === 'escape') return app.pop()
      if (key.name === 'up' || (key.name === 'tab' && key.shift)) return setIndex(Math.max(0, at - 1))
      if (key.name === 'down' || (key.name === 'tab' && !key.shift)) return setIndex(Math.min(fields.length - 1, at + 1))
      if (field?.kind === 'boolean' && (key.name === 'space' || key.name === 'left' || key.name === 'right')) {
        const next = { ...values, [field.name]: values[field.name] !== true }
        // Toggling "More options" inserts rows above it; keep the cursor on the toggle.
        setIndex(Math.max(0, visibleFields(allFields, next).findIndex((entry) => entry.name === field.name)))
        return setValues(next)
      }
      if (field?.kind === 'choice' && (key.name === 'left' || key.name === 'right' || key.name === 'space')) {
        return cycleChoice(key.name === 'left' ? -1 : 1)
      }
      if (ENTER.has(key.name)) return activate()
      if (key.ctrl && key.name === 'r') return void run()
      return
    }
    if (phase.kind === 'result') {
      if (key.name === 'escape') return setPhase({ kind: 'form' })
      if (key.name === 'j') return setPhase({ ...phase, showJson: !phase.showJson })
      if ((key.ctrl && key.name === 'r') || ENTER.has(key.name)) return void run()
      return
    }
    if (phase.kind === 'plan') {
      if (phase.showJson) {
        if (key.name === 'escape' || key.name === 'j') return setPhase({ ...phase, showJson: false })
        return
      }
      if (key.name === 'escape') return setPhase({ kind: 'form' })
      if (key.name === 'j') return setPhase({ ...phase, showJson: true })
      if (ENTER.has(key.name)) return sign(phase.plan)
      return
    }
    if (phase.kind === 'sent') {
      if (key.name === 'escape' || ENTER.has(key.name)) return app.pop()
    }
  })

  const hints = phase.kind === 'form'
    ? [
        { key: '↑↓', label: 'field' },
        { key: 'enter', label: enterLabel(field, at >= fields.length - 1, isTx) },
        { key: 'ctrl+r', label: isTx ? 'build plan' : 'run' },
        { key: 'esc', label: 'back' },
      ]
    : phase.kind === 'result'
      ? [{ key: '↑↓', label: 'scroll' }, { key: 'j', label: phase.showJson ? 'readable' : 'json' }, { key: 'ctrl+r', label: 'refresh' }, { key: 'esc', label: 'back' }]
      : phase.kind === 'plan'
        ? phase.showJson
          ? [{ key: '↑↓', label: 'scroll' }, { key: 'esc', label: 'back to plan' }]
          : [{ key: 'enter', label: 'sign & broadcast' }, { key: 'j', label: 'raw plan' }, { key: 'esc', label: 'back' }]
        : phase.kind === 'sent'
          ? [{ key: 'enter', label: 'done' }]
          : [{ key: '', label: 'working...' }]

  return (
    <ScreenFrame title={title} hints={hints}>
      {phase.kind === 'form' ? (
        <box flexGrow={1} minHeight={0}>
          <scrollbox flexGrow={1} minHeight={0}>
            {fields.map((item, position) => (
              <FieldRow
                key={item.name}
                field={item}
                value={values[item.name]}
                active={position === at}
                editable={!app.dialogOpen}
                // A hand-typed pool is of unknown type; only the picker knows it is CL.
                onInput={(value) => (item.name === 'pool' ? patch({ pool: value, [POOL_IS_CL]: false }) : setValue(item.name, value))}
              />
            ))}
          </scrollbox>
          <box height={1} flexShrink={0} paddingLeft={1}>
            <text fg={theme.textMuted}>{field?.help ?? ''}</text>
          </box>
        </box>
      ) : phase.kind === 'running' ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label={phase.label} />
        </box>
      ) : phase.kind === 'result' && phase.showJson ? (
        <JsonView data={phase.data} focused={!app.dialogOpen} />
      ) : phase.kind === 'result' ? (
        <HumanResultView action={props.action} data={phase.data} focused={!app.dialogOpen} />
      ) : phase.kind === 'plan' && phase.showJson ? (
        <JsonView data={phase.plan.result} focused={!app.dialogOpen} />
      ) : phase.kind === 'plan' ? (
        <box flexGrow={1} minHeight={0} gap={1}>
          <box border borderStyle="rounded" borderColor={theme.borderActive} paddingLeft={1} paddingRight={1}>
            {phase.plan.summary.split('\n').map((line, row) => (
              <text key={row} fg={row === 0 ? theme.primary : theme.text} attributes={row === 0 ? TextAttributes.BOLD : undefined}>{line}</text>
            ))}
          </box>
          <box paddingLeft={1}>
            {phase.plan.steps.map((step, row) => (
              <text key={row} fg={theme.textMuted}>
                {`${row + 1}. ${step.role === 'approval' ? 'approve' : 'execute'} → `}
                <span fg={theme.text}>{step.transaction.to}</span>
              </text>
            ))}
          </box>
          <box paddingLeft={1}>
            <text fg={theme.warning}>Signing sends real transactions on chain {app.chain}. Early beta: review every step above.</text>
          </box>
        </box>
      ) : phase.kind === 'broadcast' ? (
        <box flexGrow={1} minHeight={0} gap={1}>
          <Spinner label="Signing and broadcasting..." />
          <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
            {log.map((line, row) => (
              <text key={row} fg={theme.text}>{line}</text>
            ))}
          </scrollbox>
        </box>
      ) : (
        <box flexGrow={1} minHeight={0} gap={1}>
          <text fg={theme.success} attributes={TextAttributes.BOLD}>✓ Sent and confirmed</text>
          <box paddingLeft={1}>
            {phase.hashes.map((hash) => (
              <text key={hash} fg={theme.text} selectable>{hash}</text>
            ))}
          </box>
        </box>
      )}
    </ScreenFrame>
  )
}
