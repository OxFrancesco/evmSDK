/**
 * Shared fuzzy matcher for every searchable list in the package (TUI select
 * dialogs and the CLI token finder), so "weth usdc" finds the same entries
 * in both surfaces.
 */

function fuzzyWordScore(word: string, lower: string): number | undefined {
  const direct = lower.indexOf(word)
  if (direct !== -1) return Math.min(direct, 3)
  let score = 1000
  let index = -1
  for (const char of word) {
    const found = lower.indexOf(char, index + 1)
    if (found === -1) return undefined
    score += found - index
    index = found
  }
  return score
}

/**
 * Case-insensitive fuzzy match; lower score is better. Every whitespace
 * separated word must match on its own, so "weth usdc" finds
 * "vAMM-WETH/USDC" regardless of separators or word order.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return 0
  const lower = candidate.toLowerCase()
  let total = 0
  for (const word of words) {
    const score = fuzzyWordScore(word, lower)
    if (score === undefined) return undefined
    total += score
  }
  return total
}
