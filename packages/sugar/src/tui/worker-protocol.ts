import type { SugarAction, SugarParameters } from '../contracts'
import type { SugarJson, Token } from '../types'
import type { AnalyticsReport } from './analytics/load'
import type { LlamaSnapshot } from './analytics/llama'
import type { TuiActionUpdate } from './sugar-runtime'

export const POOLS_BROWSE_PARAMETERS = { full: true } as const

export type TuiWorkerTask =
  | { kind: 'action'; action: SugarAction; parameters: SugarParameters; fresh?: boolean }
  | { kind: 'subscribe'; action: SugarAction; parameters: SugarParameters; fresh?: boolean }
  | { kind: 'prefetch'; action: SugarAction; parameters: SugarParameters }
  | { kind: 'tokens'; chain: number }
  | { kind: 'warm'; chain: number; wallet?: string }
  | { kind: 'clear' }
  | { kind: 'llama'; chain: number }
  | { kind: 'analytics'; chain: number; fresh: boolean }
  | { kind: 'cancel' }

export type TuiWorkerRequest = TuiWorkerTask & { id: number }

export type TuiWorkerResult =
  | { kind: 'action'; data: SugarJson }
  | { kind: 'tokens'; data: Token[] }
  | { kind: 'llama'; data: LlamaSnapshot | undefined }
  | { kind: 'analytics'; data: AnalyticsReport }
  | { kind: 'done' }

export type TuiWorkerUpdate =
  | { kind: 'action-update'; update: TuiActionUpdate }
  | { kind: 'analytics-update'; report: AnalyticsReport }

export type TuiWorkerMessage =
  | { id: number; kind: 'result'; result: TuiWorkerResult }
  | { id: number; kind: 'error'; message: string }
  | (TuiWorkerUpdate & { id: number })
  | { kind: 'rpc' }
