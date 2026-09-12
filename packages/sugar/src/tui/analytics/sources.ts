import { theme } from '../theme'

export type AnalyticSource = 'sugar' | 'dune' | 'llama'

export const SOURCE = {
  sugar: { id: 'sugar' as const, label: 'Sugar', detail: 'on-chain', color: theme.primary },
  dune: { id: 'dune' as const, label: 'Dune', detail: 'dune.com', color: theme.accent },
  llama: { id: 'llama' as const, label: 'DefiLlama', detail: 'defillama.com', color: theme.secondary },
}

export function sourceLabel(id: AnalyticSource): string {
  return SOURCE[id].label
}
