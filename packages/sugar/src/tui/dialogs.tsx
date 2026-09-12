import { RGBA, TextAttributes } from '@opentui/core'
import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { fuzzyScore } from '../fuzzy'
import { theme } from './theme'
import { KeyHints } from './widgets'

/**
 * Modal dialogs styled after the opencode TUI: a dimmed backdrop, a fixed
 * width panel dropped at 1/4 height, escape to close. Only the topmost
 * dialog is mounted (see DialogHost), so every dialog may bind keys freely.
 */

const BACKDROP = RGBA.fromInts(0, 0, 0, 150)

export function Dialog(props: { title: string; width?: number; children: ReactNode; hints?: { key: string; label: string }[] }) {
  const dimensions = useTerminalDimensions()
  const width = Math.min(props.width ?? 64, dimensions.width - 4)
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={dimensions.width}
      height={dimensions.height}
      alignItems="center"
      paddingTop={Math.max(1, Math.floor(dimensions.height / 5))}
      backgroundColor={BACKDROP}
      zIndex={100}
    >
      <box width={width} backgroundColor={theme.backgroundPanel} border borderStyle="rounded" borderColor={theme.borderActive} paddingLeft={1} paddingRight={1}>
        <box height={1} paddingLeft={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{props.title}</text>
        </box>
        {props.children}
        {props.hints ? (
          <box height={1} paddingLeft={1} paddingTop={0}>
            <KeyHints hints={props.hints} />
          </box>
        ) : null}
      </box>
    </box>
  )
}

export type SelectItem = {
  /** Stable identity when titles can collide (e.g. token symbols); falls back to title. */
  id?: string
  title: string
  description?: string
  hint?: string
  searchText?: string
  onSelect: () => void
}

function filterSelectItems(items: SelectItem[], filter: string): SelectItem[] {
  if (filter.trim() === '') return items
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(filter, `${item.title} ${item.description ?? ''} ${item.searchText ?? ''}`) }))
    .filter((entry): entry is { item: SelectItem; score: number } => entry.score !== undefined)
  return scored.sort((left, right) => left.score - right.score).map((entry) => entry.item)
}

export function SelectDialog(props: { title: string; items: SelectItem[]; placeholder?: string; initialFilter?: string; close: () => void }) {
  const [filter, setFilter] = useState(props.initialFilter ?? '')
  const filterRef = useRef(filter)
  const [selected, setSelected] = useState(0)
  // Live cursor for batched key events (held arrow / fast ↓↓⏎); state only
  // mirrors it for rendering. See BrowseList for the same pattern.
  const selectedRef = useRef(0)
  const filtered = useMemo(() => filterSelectItems(props.items, filter), [props.items, filter])
  const currentItems = () => filterRef.current === filter ? filtered : filterSelectItems(props.items, filterRef.current)
  const active = Math.min(selected, Math.max(0, filtered.length - 1))
  const visibleCount = 10
  const offset = Math.max(0, Math.min(active - visibleCount + 2, filtered.length - visibleCount))
  const visible = filtered.slice(offset, offset + visibleCount)

  const select = (next: number) => {
    const clamped = Math.max(0, Math.min(next, currentItems().length - 1))
    selectedRef.current = clamped
    setSelected(clamped)
  }

  useKeyboard((key) => {
    if (key.name === 'escape') return props.close()
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) return select(selectedRef.current - 1)
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) return select(selectedRef.current + 1)
    if (key.name === 'pageup') return select(selectedRef.current - visibleCount)
    if (key.name === 'pagedown') return select(selectedRef.current + visibleCount)
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
      const items = currentItems()
      const item = items[Math.min(selectedRef.current, items.length - 1)]
      if (item) {
        props.close()
        item.onSelect()
      }
    }
  })

  return (
    <Dialog title={props.title} hints={[{ key: '↑↓', label: 'move' }, { key: 'enter', label: 'select' }, { key: 'esc', label: 'close' }]}>
      <box height={1} paddingLeft={1} backgroundColor={theme.backgroundElement}>
        <input
          focused
          value={filter}
          placeholder={props.placeholder ?? 'Type to filter...'}
          onInput={(value) => {
            filterRef.current = value
            setFilter(value)
            selectedRef.current = 0
            setSelected(0)
          }}
          backgroundColor={theme.backgroundElement}
          focusedBackgroundColor={theme.backgroundElement}
          textColor={theme.text}
          focusedTextColor={theme.text}
          placeholderColor={theme.textMuted}
        />
      </box>
      <box paddingTop={1} paddingBottom={1}>
        {visible.length === 0 ? (
          <box height={1} paddingLeft={1}>
            <text fg={theme.textMuted}>No matches</text>
          </box>
        ) : (
          visible.map((item, index) => {
            const isActive = offset + index === active
            return (
              <box
                key={item.id ?? item.title}
                height={1}
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isActive ? theme.primary : undefined}
              >
                <text fg={isActive ? theme.selectedText : theme.text}>
                  {item.title}
                  {item.description ? <span fg={isActive ? theme.selectedText : theme.textMuted}>  {item.description}</span> : null}
                </text>
                {item.hint ? <text fg={isActive ? theme.selectedText : theme.textMuted}>{item.hint}</text> : null}
              </box>
            )
          })
        )}
      </box>
    </Dialog>
  )
}

export function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  close: () => void
  onConfirm: () => void
  onCancel?: () => void
}) {
  const [choice, setChoice] = useState<'cancel' | 'confirm'>('cancel')
  const cancel = () => {
    props.close()
    props.onCancel?.()
  }
  const confirm = () => {
    props.close()
    props.onConfirm()
  }
  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'n') return cancel()
    if (key.name === 'y') return confirm()
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
      return setChoice((current) => (current === 'cancel' ? 'confirm' : 'cancel'))
    }
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
      return choice === 'confirm' ? confirm() : cancel()
    }
  })
  const accent = props.danger ? theme.error : theme.primary
  return (
    <Dialog title={props.title} hints={[{ key: '←→', label: 'choose' }, { key: 'enter', label: 'confirm' }, { key: 'esc', label: 'cancel' }]}>
      <box paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text fg={theme.text}>{props.message}</text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={choice === 'cancel' ? theme.backgroundElement : undefined}>
          <text fg={choice === 'cancel' ? theme.text : theme.textMuted}>Cancel</text>
        </box>
        <box paddingLeft={1} paddingRight={1} backgroundColor={choice === 'confirm' ? accent : undefined}>
          <text fg={choice === 'confirm' ? theme.selectedText : accent}>{props.confirmLabel ?? 'Confirm'}</text>
        </box>
      </box>
    </Dialog>
  )
}

/** Text prompt; `mask` renders bullets and captures keys manually (passphrases, mnemonics). */
export function PromptDialog(props: {
  title: string
  label?: string
  placeholder?: string
  mask?: boolean
  close: () => void
  onSubmit: (value: string) => void
  onCancel?: () => void
}) {
  const [value, setValue] = useState('')
  const submit = (submitted: string) => {
    props.close()
    props.onSubmit(submitted)
  }
  const cancel = () => {
    props.close()
    props.onCancel?.()
  }
  useKeyboard((key) => {
    if (key.name === 'escape') return cancel()
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') return submit(value)
    if (!props.mask) return
    if (key.name === 'backspace') return setValue((current) => Array.from(current).slice(0, -1).join(''))
    if (key.ctrl && key.name === 'u') return setValue('')
    if (key.ctrl || key.meta || key.option) return
    if (key.sequence && Array.from(key.sequence).length === 1 && key.sequence.charCodeAt(0) >= 0x20) {
      setValue((current) => current + key.sequence)
    }
  })
  usePaste((event) => {
    if (props.mask) setValue((current) => current + new TextDecoder().decode(event.bytes).replaceAll('\n', ' '))
  })
  return (
    <Dialog title={props.title} hints={[{ key: 'enter', label: 'submit' }, { key: 'esc', label: 'cancel' }]}>
      {props.label ? (
        <box paddingLeft={1} paddingTop={1}>
          <text fg={theme.textMuted}>{props.label}</text>
        </box>
      ) : null}
      <box height={1} marginTop={1} marginBottom={1} paddingLeft={1} backgroundColor={theme.backgroundElement}>
        {props.mask ? (
          <text fg={theme.text}>{value.length > 0 ? '•'.repeat(Math.min(value.length, 40)) : ' '}</text>
        ) : (
          <input
            focused
            value={value}
            placeholder={props.placeholder}
            onInput={setValue}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
          />
        )}
      </box>
    </Dialog>
  )
}
