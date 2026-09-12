import { TextAttributes } from '@opentui/core'
import { memo, type ReactNode } from 'react'
import { theme } from '../theme'
import { groupRuns, type DitherCell } from './dither'
import { SOURCE, type AnalyticSource } from './sources'

export function SourceTag(props: { source: AnalyticSource }) {
  const meta = SOURCE[props.source]
  return (
    <text>
      <span fg={meta.color}>{meta.label}</span>
    </text>
  )
}

/** Memoized: chart matrices are pure data; skip cell-by-cell diffing when
 * the parent re-renders without new rows (e.g. cursor moves). */
export const DitherLines = memo(function DitherLines(props: { rows: DitherCell[][] }) {
  return (
    <box>
      {props.rows.map((row, y) => (
        <text key={y}>
          {groupRuns(row).map((run, index) => (
            <span key={index} fg={run.color}>{run.text}</span>
          ))}
        </text>
      ))}
    </box>
  )
})

export function Panel(props: {
  title: string
  hint?: string
  source?: AnalyticSource
  children: ReactNode
  flexGrow?: number
  width?: number
}) {
  return (
    <box
      flexGrow={props.flexGrow ?? 1}
      minHeight={0}
      width={props.width}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <box height={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>{props.title}</text>
        {props.source ? <SourceTag source={props.source} /> : props.hint ? <text fg={theme.textMuted}>{props.hint}</text> : null}
      </box>
      {props.children}
    </box>
  )
}

export function Kpi(props: { label: string; value: string; source?: AnalyticSource; color?: string }) {
  return (
    <box
      flexGrow={1}
      minWidth={14}
      height={3}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.textMuted}>
        {props.label}
        {props.source ? <span>  <span fg={SOURCE[props.source].color}>{SOURCE[props.source].label}</span></span> : null}
      </text>
      <text fg={props.color ?? theme.text} attributes={TextAttributes.BOLD}>{props.value}</text>
    </box>
  )
}

export function ChartBox(props: { width: number; children: ReactNode }) {
  return (
    <box width={props.width} flexShrink={0}>
      {props.children}
    </box>
  )
}

export function Legend(props: { items: { label: string; color: string }[] }) {
  return (
    <text fg={theme.textMuted}>
      {props.items.map((item, index) => (
        <span key={item.label}>
          {index > 0 ? <span>  </span> : null}
          <span fg={item.color}>█</span>
          <span> {item.label}</span>
        </span>
      ))}
    </text>
  )
}
