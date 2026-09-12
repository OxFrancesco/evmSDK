import type { SugarAction } from '../contracts'
import type { SugarJson } from '../types'
import { formatNumber, formatUsd, jsonNumber, jsonRecord, jsonString, pad } from './format'

/**
 * Human-readable projections of Sugar action results for the TUI. The
 * headless CLI keeps printing raw JSON; here every read renders as aligned
 * text lines and the JSON stays behind the `j` toggle.
 */

const scaledNumber = (value: SugarJson | undefined, decimals = 18): number => {
  const raw = jsonString(value) ?? (jsonNumber(value) === undefined ? undefined : String(jsonNumber(value)))
  return raw === undefined ? 0 : Number(raw) / 10 ** decimals
}

function quoteLines(data: SugarJson): string[] | undefined {
  const quote = jsonRecord(data)
  if (!quote) return undefined
  const from = jsonRecord(quote.from_token)
  const to = jsonRecord(quote.to_token)
  if (!from || !to) return undefined
  const amountIn = jsonNumber(quote.amount_in_decimal) ?? 0
  const amountOut = jsonNumber(quote.amount_out_decimal) ?? 0
  const lines = [
    `${formatNumber(amountIn)} ${jsonString(from.symbol)} → ${formatNumber(amountOut)} ${jsonString(to.symbol)}`,
    `price      1 ${jsonString(from.symbol)} = ${formatNumber(jsonNumber(quote.price) ?? 0)} ${jsonString(to.symbol)}`,
  ]
  const impact = jsonNumber(quote.price_impact_pct)
  if (impact !== undefined) lines.push(`impact     ${impact.toFixed(3)}%`)
  const fromUsd = jsonNumber(quote.from_price_usd)
  const toUsd = jsonNumber(quote.to_price_usd)
  if (fromUsd !== undefined && toUsd !== undefined) {
    lines.push(`value      ${formatUsd(amountIn * fromUsd)} in → ${formatUsd(amountOut * toUsd)} out`)
  }
  const minOut = jsonNumber(quote.min_amount_out_decimal)
  if (minOut !== undefined) lines.push(`min out    ${formatNumber(minOut)} ${jsonString(to.symbol)} (slippage ${jsonNumber(quote.slippage) ?? '-'})`)
  const route = Array.isArray(quote.route) ? quote.route : []
  if (route.length > 0) {
    const hops = route.map((hop) => {
      const record = jsonRecord(hop)
      return record ? `${jsonString(record.symbol) ?? '?'} (${jsonString(record.type_label) ?? 'pool'})` : '?'
    })
    lines.push(`route      ${jsonString(from.symbol)} → ${hops.join(' → ')}`)
  } else {
    lines.push('route      direct')
  }
  return lines
}

function positionLines(data: SugarJson): string[] | undefined {
  if (!Array.isArray(data)) return undefined
  if (data.length === 0) return ['No positions on this chain.']
  const lines = [`${pad('POOL', 28)} ${pad('ID', 7)} ${pad('AMOUNT0', 10)} ${pad('AMOUNT1', 10)} ${pad('STATE', 8)} EARNED`]
  for (const entry of data) {
    const position = jsonRecord(entry)
    const pool = position ? jsonRecord(position.pool) : undefined
    if (!position || !pool) continue
    const token0 = jsonRecord(pool.token0)
    const token1 = jsonRecord(pool.token1)
    const decimals0 = jsonNumber(token0?.decimals) ?? 18
    const decimals1 = jsonNumber(token1?.decimals) ?? 18
    const amount0 = scaledNumber(position.amount_token0, decimals0) + scaledNumber(position.staked_token0, decimals0)
    const amount1 = scaledNumber(position.amount_token1, decimals1) + scaledNumber(position.staked_token1, decimals1)
    const emissions = scaledNumber(position.emissions_earned)
    lines.push([
      pad(jsonString(pool.symbol) ?? '?', 28),
      pad(jsonString(position.id) ?? String(jsonNumber(position.id) ?? '?'), 7),
      pad(formatNumber(amount0), 10),
      pad(formatNumber(amount1), 10),
      pad(scaledNumber(position.staked, 0) > 0 ? 'staked' : 'unstaked', 8),
      emissions > 0 ? formatNumber(emissions) : '-',
    ].join(' '))
  }
  return lines
}

function poolLines(data: SugarJson): string[] | undefined {
  if (!Array.isArray(data)) return undefined
  if (data.length === 0) return ['No pools matched.']
  const full = jsonRecord(data[0])?.symbol !== undefined
  const lines = [full
    ? `${pad('POOL', 32)} ${pad('TYPE', 9)} ${pad('TVL', 11)} GAUGE`
    : `${pad('POOL ADDRESS', 44)} TYPE`]
  for (const entry of data) {
    const pool = jsonRecord(entry)
    if (!pool) continue
    if (full) {
      const tvl = jsonNumber(pool.tvl)
      lines.push([
        pad(jsonString(pool.symbol) ?? '?', 32),
        pad(jsonString(pool.type_label) ?? '?', 9),
        pad(tvl === undefined ? '-' : formatUsd(tvl), 11),
        pool.gauge_alive === true ? '● alive' : '-',
      ].join(' '))
    } else {
      lines.push(`${pad(jsonString(pool.lp) ?? '?', 44)} ${jsonString(pool.type_label) ?? '?'}`)
    }
  }
  return lines
}

function epochLines(data: SugarJson): string[] | undefined {
  if (!Array.isArray(data)) return undefined
  if (data.length === 0) return ['No epochs returned.']
  const lines = [`${pad('POOL', 26)} ${pad('DATE', 10)} ${pad('VOTES', 10)} ${pad('EMISSIONS', 10)} ${pad('FEES', 9)} INCENTIVES`]
  for (const entry of data) {
    const epoch = jsonRecord(entry)
    if (!epoch) continue
    const pool = jsonRecord(epoch.pool)
    lines.push([
      pad(jsonString(pool?.symbol) ?? jsonString(epoch.lp) ?? '?', 26),
      pad(jsonString(epoch.epoch_date)?.slice(0, 10) ?? '-', 10),
      pad(formatNumber(scaledNumber(epoch.votes)), 10),
      pad(formatNumber(scaledNumber(epoch.emissions)), 10),
      pad(formatUsd(jsonNumber(epoch.total_fees) ?? 0), 9),
      formatUsd(jsonNumber(epoch.total_incentives) ?? 0),
    ].join(' '))
  }
  return lines
}

export type HumanResult = { lines: string[]; hasHeader: boolean }

export function humanizeResult(action: SugarAction, data: SugarJson): HumanResult {
  const trades = jsonRecord(data)?.trades
  if (action === 'index_rebalance' && Array.isArray(trades) && trades.length === 0) return { lines: ['Already balanced. No transactions needed.'], hasHeader: false }
  const tabular = action === 'positions' || action === 'pools' || action === 'epochs' || action === 'epochs_latest'
  const lines = action === 'quote'
    ? quoteLines(data)
    : action === 'positions'
      ? positionLines(data)
      : action === 'pools'
        ? poolLines(data)
        : action === 'epochs' || action === 'epochs_latest'
          ? epochLines(data)
          : undefined
  if (lines) return { lines, hasHeader: tabular && lines.length > 1 }
  return { lines: JSON.stringify(data, null, 2).split('\n'), hasHeader: false }
}
