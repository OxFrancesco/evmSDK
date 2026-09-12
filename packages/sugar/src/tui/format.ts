import * as Predicate from 'effect/Predicate'
import type { SugarJson } from '../types'

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(digits)}K`
  if (abs > 0 && abs < 0.0001) return value.toExponential(2)
  return value.toFixed(abs < 1 ? 4 : digits)
}

export function formatUsd(value: number): string {
  return `$${formatNumber(value)}`
}

export function formatPercent(value: number | undefined, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatRatio(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

export function formatAge(savedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - savedAt) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export function weekLabel(ts: number): string {
  const date = new Date(ts * 1000)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

export function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

export function jsonRecord(value: SugarJson): Record<string, SugarJson> | undefined {
  // SAFETY: a SugarJson that is an object and not an array is exactly the
  // record arm of the SugarJson union.
  return value !== null && Predicate.isObject(value) && !Array.isArray(value) ? value as Record<string, SugarJson> : undefined
}

export function jsonNumber(value: SugarJson | undefined): number | undefined {
  return Predicate.isNumber(value) ? value : undefined
}

export function jsonString(value: SugarJson | undefined): string | undefined {
  return Predicate.isString(value) ? value : undefined
}
