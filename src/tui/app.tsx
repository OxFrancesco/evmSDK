import { stripVTControlCharacters } from 'node:util'
import { flushSync, useKeyboard } from '@opentui/react'
import { Abi as AbiValidator } from 'abitype/zod'
import { Schema } from 'effect'
import { useEffect, useRef, useState } from 'react'
import { formatAbi } from 'abitype'
import { commands } from '../catalog'
import { Plan, WorkspaceEntry } from '../model'
import { BalanceView, BlockView, InspectView, OperationView, ReadView, TokenView } from '../outputs'
import { Workflow, WorkflowResult } from '../workflows'
import { BridgeRecord } from '../socket'
import { Batch } from '../batches'
import { Hash } from '../model'
import { forms } from './forms'

export interface TuiResult { readonly ok: boolean; readonly value: Schema.Json }
export interface TuiProps {
  readonly run: (command: string, input: Schema.Json) => Promise<TuiResult>
  readonly quit: () => void
  readonly subscribePairing?: (listener: (message: string) => void) => () => void
  readonly getWallet?: () => Promise<string | null>
}

const record = Schema.Record(Schema.String, Schema.Json)
const clean = (text: string) => Array.from(stripVTControlCharacters(text)).filter(character => character === '\n' || character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('')

function describe(value: Schema.Json, prefix = ''): ReadonlyArray<string> {
  const tokens = Schema.decodeUnknownOption(Schema.Struct({ chainId: Schema.Number, tokens: Schema.Array(Schema.Struct({ symbol: Schema.String, name: Schema.String, address: Schema.String, decimals: Schema.Number })) }))(value)
  if (tokens._tag === 'Some') return [`Chain ${tokens.value.chainId}`, ...tokens.value.tokens.flatMap(token => [`${clean(token.symbol)}${token.name !== token.symbol ? ` · ${clean(token.name)}` : ''} · ${token.decimals} decimals`, token.address])]
  const read = Schema.decodeUnknownOption(ReadView)(value)
  if (read._tag === 'Some') return [...describe(read.value.value, 'Value: '), `Block: ${read.value.block}`]
  const balance = Schema.decodeUnknownOption(BalanceView)(value)
  if (balance._tag === 'Some') return [`Balance: ${balance.value.balanceWei} wei`, `Block: ${balance.value.block}`]
  const token = Schema.decodeUnknownOption(TokenView)(value)
  if (token._tag === 'Some') return [`${clean(token.value.symbol)} · ${token.value.decimals} decimals`, `Balance: ${token.value.amount} base units`, `Block: ${token.value.block}`]
  const block = Schema.decodeUnknownOption(BlockView)(value)
  if (block._tag === 'Some') {
    const data = block.value
    return [`Block ${data.number} · Chain ${data.chainId}`, `Time: ${new Date(Number(data.timestamp) * 1000).toISOString()}`, `Transactions: ${data.transactions}`, `Gas used: ${data.gasUsed} / ${data.gasLimit}`, `Base fee: ${data.baseFeePerGas ?? 'unavailable'} wei`, `Hash: ${data.hash}`]
  }
  const operation = Schema.decodeUnknownOption(OperationView)(value)
  if (operation._tag === 'Some') {
    const { plan, state } = operation.value
    return [`${state._tag} · Chain ${plan.chainId}`, `From: ${plan.account}`, `To: ${plan.to}`, `Value: ${plan.value} wei`, `Data: ${plan.data}`, `Gas limit: ${plan.gas}`, `Gas price cap: ${plan.gasPrice} wei`, `Expires: ${new Date(plan.expiresAt).toISOString()}`, ...('hash' in state ? [`Transaction: ${state.hash}`] : [])]
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => describe(item, `${prefix}${index + 1}. `))
  if (Schema.is(record)(value)) return Object.entries(value).flatMap(([key, item]) => {
    if (key === 'fingerprint' || key === 'intentHash' || key === 'id' || key === 'raw') return []
    return describe(item, `${prefix}${key === '_tag' ? 'State' : key}: `)
  })
  return [`${prefix}${clean(String(value))}`]
}

export function App({ run, quit, subscribePairing, getWallet }: TuiProps) {
  const [pairing, setPairing] = useState('')
  const [search, setSearch] = useState('')
  const [workflowReview, setWorkflowReview] = useState<{ command: string; input: Readonly<Record<string, Schema.Json>>; fingerprint: string } | null>(null)
  useEffect(() => subscribePairing?.(setPairing), [subscribePairing])
  const [name, setName] = useState('inspect')
  const [values, setValues] = useState(new Map<string, string>())
  const [focus, setFocus] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TuiResult | null>(null)
  const [review, setReview] = useState<Plan | null>(null)
  const generation = useRef(0)
  const fields = forms.get(name) ?? []
  useEffect(() => {
    if (!getWallet || !fields.some(field => ['account', 'userAddress', 'receiverAddress'].includes(field.name))) return
    let active = true
    void getWallet().then(address => {
      if (!active || !address) return
      setValues(current => {
        const next = new Map(current)
        for (const field of fields) if (['account', 'userAddress', 'receiverAddress'].includes(field.name) && !next.get(field.name)) next.set(field.name, address)
        return next
      })
    }).catch(() => {})
    return () => { active = false }
  }, [name, getWallet, fields])
  const filteredCommands = commands.filter(c => !search || `${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase()))
  const selected = commands.find(command => command.name === name)
  const inspection = result?.ok && name === 'inspect' ? Schema.decodeUnknownOption(InspectView)(result.value) : null
  const parsedAbi = inspection?._tag === 'Some' ? AbiValidator.safeParse(inspection.value.abi) : null
  const functions = parsedAbi?.success ? parsedAbi.data.filter(item => item.type === 'function') : []
  const operations = result?.ok && name === 'operations' ? Schema.decodeUnknownOption(Schema.Array(OperationView))(result.value) : null
  const entries = result?.ok && name === 'workspace' ? Schema.decodeUnknownOption(Schema.Array(WorkspaceEntry))(result.value) : null

  const choose = (next: string) => {
    generation.current += 1
    setName(next); setValues(new Map()); setResult(null); setReview(null); setWorkflowReview(null); setPairing(''); setFocus(-1)
  }
  const submit = async (executeReviewed = false) => {
    if (busy) return
    const currentGeneration = generation.current
    setBusy(true)
    try {
      let input: Schema.Json
      if (executeReviewed && workflowReview) input = { ...workflowReview.input, approval: { _tag: 'approved', fingerprint: workflowReview.fingerprint } }
      else if (executeReviewed && review) input = { id: review.id, approval: { _tag: 'approved', fingerprint: review.fingerprint } }
      else {
        const pairs = fields.flatMap(field => {
          const value = values.get(field.name) ?? field.initial
          if (field.optional && value === '') return []
          const decoded = field.kind === 'json' ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(value) : field.kind === 'number' ? Number(value) : value
          return [[field.name, decoded]]
        })
        input = Schema.decodeUnknownSync(record)(Object.fromEntries(pairs))
        if (['execute', 'workflow-run', 'bridge-run', 'batch-run'].includes(name) && Schema.is(record)(input)) input = { ...input, approval: { _tag: 'required' } }
      }
      const response = await run(executeReviewed ? workflowReview?.command ?? 'execute' : name, input)
      if (generation.current !== currentGeneration) return
      setResult(response)
      setPairing('')
      const workflow = Schema.decodeUnknownOption(Workflow)(response.value)
      const workflowResult = Schema.decodeUnknownOption(WorkflowResult)(response.value)
      const bridge = Schema.decodeUnknownOption(Schema.Struct({ bridge: BridgeRecord, workflow: WorkflowResult }))(response.value)
      const aeroWorkflow = Schema.decodeUnknownOption(Schema.Struct({ workflow: Workflow }))(response.value)
      const batch = Schema.decodeUnknownOption(Batch)(response.value)
      const typed = Schema.decodeUnknownOption(Schema.Struct({ fingerprint: Hash, signature: Schema.Null }))(response.value)
      const reviewed = workflow._tag === 'Some' ? workflow.value : workflowResult._tag === 'Some' ? workflowResult.value.workflow : aeroWorkflow._tag === 'Some' ? aeroWorkflow.value.workflow : null
      setWorkflowReview(!response.ok ? null : bridge._tag === 'Some' ? { command: 'bridge-run', input: { id: bridge.value.bridge.id }, fingerprint: bridge.value.workflow.workflow.fingerprint } : reviewed && !reviewed.cancelled ? { command: 'workflow-run', input: { id: reviewed.id }, fingerprint: reviewed.fingerprint } : batch._tag === 'Some' && batch.value.state === 'prepared' ? { command: 'batch-run', input: { id: batch.value.id }, fingerprint: batch.value.fingerprint } : name === 'sign-typed-data' && typed._tag === 'Some' && Schema.is(record)(input) ? { command: 'sign-typed-data', input, fingerprint: typed.value.fingerprint } : null)
      const decoded = Schema.decodeUnknownOption(OperationView)(response.value)
      setReview(decoded._tag === 'Some' && ['prepared', 'pending', 'submitting', 'walletPending'].includes(decoded.value.state._tag) ? decoded.value.plan : null)
    } catch {
      setResult({ ok: false, value: 'Invalid field input. Check JSON arguments and chain number.' })
    } finally { setBusy(false) }
  }
  useKeyboard(key => {
    if (key.ctrl && key.name === 'c') quit()
    if (key.ctrl && key.name === 'k') flushSync(() => setFocus(-2))
    if (key.ctrl && key.name === 'w') { choose('wallet-connect'); setSearch('') }
    if (key.name === 'escape') flushSync(() => setFocus(-1))
    if (key.name === 'tab') flushSync(() => setFocus(current => key.shift ? Math.max(-1, current - 1) : current >= fields.length ? -1 : current + 1))
    if (key.ctrl && key.name === 'r') void submit()
    if (key.ctrl && key.name === 'e' && (review || workflowReview)) void submit(true)
  })

  return <box flexDirection="column" width="100%" height="100%" backgroundColor="#111111" padding={1} gap={1}>
    <text height={1} fg="#b4b4b4"><span fg="#ffe0c2">EVM</span>  Tab fields · Esc commands · Ctrl+R run · Ctrl+K search · Ctrl+W wallet · Ctrl+C quit</text>
    <box flexDirection="row" flexGrow={1} gap={2}>
      <box width={23} flexDirection="column" border borderColor="#35312c">
        <input focused={focus === -2 && !busy} placeholder="Search commands" value={search} onInput={setSearch} onSubmit={() => { const first = filteredCommands[0]; if (first) choose(first.name) }} />
        <select focused={focus === -1 && !busy} flexGrow={1} options={filteredCommands.map(command => ({ name: command.name, value: command.name, description: '' }))}
          selectedIndex={filteredCommands.findIndex(command => command.name === name)}
          showDescription={false} selectedBackgroundColor="#393028" selectedTextColor="#ffe0c2" textColor="#b4b4b4"
          onChange={(_index, option) => { if (option && option.value !== name) choose(option.value) }} />
      </box>
      <scrollbox flexGrow={1} contentOptions={{ flexDirection: 'column', gap: 1 }}>
        <text fg="#eeeeee">{selected?.description ?? name}</text>
        {fields.map((field, index) => <box key={`${name}:${field.name}`} flexDirection="column" height={2}>
          <text fg={focus === index ? '#ffe0c2' : '#b4b4b4'}>{field.label}{field.optional ? ' · optional' : ''}</text>
          {field.choices ? <select height={1} focused={focus === index && !busy} showDescription={false} options={field.choices.map(choice => ({ name: choice.label, value: choice.value, description: '' }))} selectedIndex={field.choices.findIndex(choice => choice.value === (values.get(field.name) ?? field.initial))} onChange={(_index, option) => { if (option) setValues(current => new Map(current).set(field.name, option.value)) }} /> : <input focused={focus === index && !busy} value={values.get(field.name) ?? field.initial}
            backgroundColor="#191919" focusedBackgroundColor="#2a2a2a" textColor="#eeeeee"
            onInput={value => flushSync(() => setValues(current => new Map(current).set(field.name, value)))}
            onSubmit={() => void submit()} />}
        </box>)}
        {pairing && <text fg="#ffe0c2" wrapMode="word">{pairing}</text>}
        {busy && <text fg="#b4b4b4">Running {name}…</text>}
        {functions.length > 0 && <select height={8} focused={focus === fields.length} showDescription={false}
          options={functions.map(fn => ({ name: formatAbi([fn])[0] ?? fn.name, value: fn.name, description: fn.stateMutability }))}
          onSelect={index => {
            const fn = functions[index]
            if (!fn || inspection?._tag !== 'Some') return
            const chain = values.get('chainId') ?? '8453'
            choose(fn.stateMutability === 'view' || fn.stateMutability === 'pure' ? 'read' : 'prepare-call')
            setValues(new Map([['chainId', chain], ['address', inspection.value.address], ['signatures', JSON.stringify(formatAbi([fn]))], ['functionName', fn.name], ['key', crypto.randomUUID()]]))
            setFocus(0)
          }} />}
        {operations?._tag === 'Some' && <select height={8} focused={focus === fields.length} showDescription={false}
          options={operations.value.map(operation => ({ name: `${operation.state._tag} · ${operation.plan.key}`, value: operation.plan.id, description: '' }))}
          onSelect={index => {
            const operation = operations.value[index]
            if (!operation) return
            choose('status'); setValues(new Map([['id', operation.plan.id]])); setResult({ ok: true, value: operation });
            if (['prepared', 'pending', 'submitting', 'walletPending'].includes(operation.state._tag)) setReview(operation.plan)
          }} />}
        {entries?._tag === 'Some' && <select height={8} focused={focus === fields.length} showDescription={false}
          options={entries.value.map(entry => ({ name: `${entry.name} · Chain ${entry.chainId}`, value: entry.name, description: '' }))}
          onSelect={index => { const entry = entries.value[index]; if (entry) { choose('inspect'); setValues(new Map([['chainId', String(entry.chainId)], ['address', entry.address]])); setFocus(0) } }} />}
        {result && !functions.length && operations?._tag !== 'Some' && entries?._tag !== 'Some' && <box flexDirection="column" gap={0} border borderColor={result.ok ? '#35312c' : '#e54d2e'} padding={1}>
          {describe(result.value).map((line, index) => <text key={index} fg={result.ok ? '#eeeeee' : '#f07858'} wrapMode="word">{line}</text>)}
        </box>}
        {review && <text fg="#ffe0c2">Ctrl+E executes the reviewed plan. EOA gas fee cap: {(BigInt(review.gas) * BigInt(review.gasPrice)).toString()} wei. L1 data fee estimate: {review.l1FeeEstimate ?? '0'} wei.</text>}
        {workflowReview && <text fg="#ffe0c2">Ctrl+E approves the displayed {workflowReview.command === 'sign-typed-data' ? 'typed data' : workflowReview.command === 'batch-run' ? 'wallet batch' : 'workflow. Steps execute separately'}.</text>}
      </scrollbox>
    </box>
  </box>
}
