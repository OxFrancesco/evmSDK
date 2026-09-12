/**
 * Terminal port of dither-kit's ordered-dither fills (Bayer 8×8).
 * Variants match the web kit: gradient, dotted, hatched, solid.
 * Cells are 1-column terminal characters, coloured per series.
 */
import { theme } from '../theme'

export const DITHER_COLORS = {
  green: theme.success,
  blue: theme.primary,
  purple: theme.accent,
  pink: '#e06c9a',
  orange: theme.warning,
  red: theme.error,
  grey: theme.textMuted,
} as const

export type DitherColor = keyof typeof DITHER_COLORS
export type DitherVariant = 'gradient' | 'dotted' | 'hatched' | 'solid'

export type DitherSeries = {
  key: string
  color: DitherColor
  variant?: DitherVariant
  values: number[]
}

export type DitherCell = { ch: string; color: string }

/** Classic Bayer 8×8, values 0–63. Same matrix dither-kit uses. */
export const BAYER8: readonly (readonly number[])[] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

const GRADIENT_RAMP = ['░', '▒', '▓', '█'] as const
const DOTTED_RAMP = ['·', '•', '●'] as const

export function bayerThreshold(x: number, y: number): number {
  const row = BAYER8[y & 7]
  return ((row?.[x & 7] ?? 0) + 0.5) / 64
}

export function ditherChar(x: number, y: number, intensity: number, variant: DitherVariant): string {
  if (intensity <= 0) return ' '
  if (variant === 'solid') return intensity >= bayerThreshold(x, y) ? '█' : ' '
  if (variant === 'hatched') {
    if (intensity < bayerThreshold(x, y)) return ' '
    return (x + y) % 2 === 0 ? '╱' : '╲'
  }
  const ramp = variant === 'dotted' ? DOTTED_RAMP : GRADIENT_RAMP
  const rank = Math.min(ramp.length - 1, Math.floor(intensity * ramp.length))
  const local = intensity * ramp.length - rank
  if (local < bayerThreshold(x, y) && rank === 0) return ' '
  return ramp[Math.max(0, local < bayerThreshold(x, y) ? rank - 1 : rank)] ?? ' '
}

export function groupRuns(row: DitherCell[]): Array<{ text: string; color: string }> {
  const runs: Array<{ text: string; color: string }> = []
  for (const cell of row) {
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color) last.text += cell.ch
    else runs.push({ text: cell.ch, color: cell.color })
  }
  return runs
}

export function chartToString(rows: DitherCell[][]): string {
  return rows.map((row) => row.map((cell) => cell.ch).join('')).join('\n')
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(value))
  const scaled = value / exp
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return nice * exp
}

function sample(values: number[], width: number): number[] {
  if (width <= 0) return []
  if (values.length === 0) return Array.from({ length: width }, () => 0)
  if (values.length === width) return values.slice()
  return Array.from({ length: width }, (_, index) => {
    const at = (index / Math.max(1, width - 1)) * (values.length - 1)
    const lo = Math.floor(at)
    const hi = Math.min(values.length - 1, lo + 1)
    const t = at - lo
    return (values[lo] ?? 0) * (1 - t) + (values[hi] ?? 0) * t
  })
}

function axisLabel(value: number, width: number): string {
  const abs = Math.abs(value)
  const text = !Number.isFinite(value) ? '-'
    : abs >= 10_000_000_000 ? `${(value / 1_000_000_000).toFixed(0)}B`
    : abs >= 1_000_000_000 ? `${(value / 1_000_000_000).toFixed(1)}B`
    : abs >= 10_000_000 ? `${(value / 1_000_000).toFixed(0)}M`
    : abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
    : abs >= 10_000 ? `${(value / 1_000).toFixed(0)}K`
    : abs >= 1_000 ? `${(value / 1_000).toFixed(1)}K`
    : abs >= 10 ? value.toFixed(0)
    : abs >= 1 ? value.toFixed(1)
    : value.toFixed(2)
  return text.slice(0, width).padStart(width)
}

export function renderArea(options: {
  series: DitherSeries[]
  width: number
  height: number
  stacked?: boolean
  axisWidth?: number
}): DitherCell[][] {
  const axisWidth = options.axisWidth ?? 6
  const plotWidth = Math.max(4, options.width - axisWidth - 1)
  const height = Math.max(3, options.height)
  const sampled = options.series.map((series) => sample(series.values, plotWidth))
  const columnMax = Array.from({ length: plotWidth }, (_, x) => {
    if (options.stacked) return sampled.reduce((sum, values) => sum + Math.max(0, values[x] ?? 0), 0)
    return sampled.reduce((max, values) => Math.max(max, values[x] ?? 0), 0)
  })
  const max = niceMax(columnMax.reduce((top, value) => Math.max(top, value), 0))
  const rows: DitherCell[][] = []
  for (let y = 0; y < height; y++) {
    const high = ((height - y) / height) * max
    const low = ((height - y - 1) / height) * max
    const label = y === 0 || y === height - 1 || y === Math.floor(height / 2)
      ? axisLabel(high, axisWidth)
      : ' '.repeat(axisWidth)
    const row: DitherCell[] = [...label].map((ch) => ({ ch, color: theme.textMuted }))
    row.push({ ch: y === height - 1 ? '└' : '│', color: theme.border })
    for (let x = 0; x < plotWidth; x++) {
      let cell: DitherCell = { ch: ' ', color: theme.border }
      if (options.stacked) {
        let cursor = 0
        for (const [index, series] of options.series.entries()) {
          const value = Math.max(0, sampled[index]?.[x] ?? 0)
          const bottom = cursor
          const top = cursor + value
          cursor = top
          if (high <= bottom || low >= top) continue
          const band = Math.max(1e-9, top - bottom)
          const fill = Math.min(1, Math.max(0, (Math.min(high, top) - Math.max(low, bottom)) / Math.min(band, max / height)))
          const ch = ditherChar(x, y, fill, series.variant ?? 'gradient')
          if (ch !== ' ') cell = { ch, color: DITHER_COLORS[series.color] }
        }
      } else {
        for (const [index, series] of options.series.entries()) {
          const value = Math.max(0, sampled[index]?.[x] ?? 0)
          if (value <= low) continue
          const fill = value >= high ? 1 : (value - low) / Math.max(1e-9, high - low)
          const ch = ditherChar(x, y, fill, series.variant ?? 'gradient')
          if (ch !== ' ') cell = { ch, color: DITHER_COLORS[series.color] }
        }
      }
      row.push(cell)
    }
    rows.push(row)
  }
  return rows
}

export function renderHBar(options: {
  value: number
  max: number
  width: number
  color: DitherColor
  variant?: DitherVariant
  y?: number
}): DitherCell[] {
  const width = Math.max(1, options.width)
  const fill = options.max <= 0 ? 0 : Math.min(1, Math.max(0, options.value / options.max))
  return Array.from({ length: width }, (_, x) => {
    const start = x / width
    const end = (x + 1) / width
    const local = fill <= start ? 0 : fill >= end ? 1 : (fill - start) / (end - start)
    return {
      ch: ditherChar(x, options.y ?? 0, local, options.variant ?? 'gradient'),
      color: DITHER_COLORS[options.color],
    }
  })
}

export function renderStackBar(options: {
  parts: Array<{ value: number; color: DitherColor; variant?: DitherVariant }>
  width: number
  y?: number
}): DitherCell[] {
  const total = options.parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  const width = Math.max(1, options.width)
  if (total <= 0) return Array.from({ length: width }, () => ({ ch: '·', color: theme.border }))
  const cells: DitherCell[] = []
  let consumed = 0
  for (const [index, part] of options.parts.entries()) {
    const share = Math.max(0, part.value) / total
    const next = index === options.parts.length - 1 ? width : Math.min(width, consumed + Math.round(share * width))
    const run = Math.max(0, next - consumed)
    for (let i = 0; i < run; i++) {
      cells.push({
        ch: '█',
        color: DITHER_COLORS[part.color],
      })
    }
    consumed = next
  }
  while (cells.length < width) cells.push({ ch: ' ', color: theme.border })
  return cells.slice(0, width)
}

/** One discrete column per value — readable week bars, no interpolation wrap. */
export function renderColumns(options: {
  values: number[]
  width: number
  height: number
  color: DitherColor
  axisWidth?: number
}): DitherCell[][] {
  const axisWidth = options.axisWidth ?? 5
  const values = options.values
  const height = Math.max(3, options.height)
  const plotWidth = Math.max(values.length, options.width - axisWidth - 1)
  const max = niceMax(values.reduce((top, value) => Math.max(top, value), 0))
  const gap = values.length > 0 && plotWidth >= values.length * 2 ? 1 : 0
  const col = values.length === 0 ? 1 : Math.max(1, Math.floor((plotWidth - gap * Math.max(0, values.length - 1)) / values.length))
  const used = values.length * col + gap * Math.max(0, values.length - 1)
  const rows: DitherCell[][] = []
  for (let y = 0; y < height; y++) {
    const high = ((height - y) / height) * max
    const low = ((height - y - 1) / height) * max
    const label = y === 0 || y === height - 1 || y === Math.floor(height / 2)
      ? axisLabel(high, axisWidth)
      : ' '.repeat(axisWidth)
    const row: DitherCell[] = [...label].map((ch) => ({ ch, color: theme.textMuted }))
    row.push({ ch: y === height - 1 ? '└' : '│', color: theme.border })
    values.forEach((value, index) => {
      const fill = value <= low ? 0 : value >= high ? 1 : (value - low) / Math.max(1e-9, high - low)
      for (let x = 0; x < col; x++) {
        row.push({
          ch: fill <= 0 ? ' ' : fill < 1 && y === height - 1 ? '▄' : '█',
          color: DITHER_COLORS[options.color],
        })
      }
      if (gap && index < values.length - 1) row.push({ ch: ' ', color: theme.border })
    })
    while (row.length < axisWidth + 1 + used) row.push({ ch: ' ', color: theme.border })
    rows.push(row)
  }
  return rows
}

export function renderSpark(values: number[], width: number, color: DitherColor): DitherCell[] {
  const sampled = sample(values, Math.max(1, width))
  const max = sampled.reduce((top, value) => Math.max(top, value), 0)
  const min = sampled.reduce((low, value) => Math.min(low, value), max)
  const span = max - min || 1
  return sampled.map((value, x) => {
    const intensity = (value - min) / span
    return { ch: ditherChar(x, 0, intensity, 'dotted'), color: DITHER_COLORS[color] }
  })
}

export function xAxisRow(labels: string[], width: number, axisWidth = 6): DitherCell[] {
  const plotWidth = Math.max(4, width - axisWidth - 1)
  const row: DitherCell[] = [...(' '.repeat(axisWidth + 1))].map((ch) => ({ ch, color: theme.textMuted }))
  if (labels.length === 0) {
    return [...row, ...Array.from({ length: plotWidth }, () => ({ ch: ' ', color: theme.textMuted }))]
  }
  const line = Array.from({ length: plotWidth }, () => ' ')
  const first = labels[0] ?? ''
  const last = labels[labels.length - 1] ?? ''
  for (let i = 0; i < first.length && i < plotWidth; i++) line[i] = first[i] ?? ' '
  const lastStart = Math.max(0, plotWidth - last.length)
  for (let i = 0; i < last.length && lastStart + i < plotWidth; i++) line[lastStart + i] = last[i] ?? ' '
  if (labels.length > 2) {
    const mid = labels[Math.floor(labels.length / 2)] ?? ''
    const midStart = Math.max(0, Math.min(plotWidth - mid.length, Math.floor((plotWidth - mid.length) / 2)))
    for (let i = 0; i < mid.length && midStart + i < plotWidth; i++) line[midStart + i] = mid[i] ?? ' '
  }
  return [...row, ...line.map((ch) => ({ ch, color: theme.textMuted }))]
}

/**
 * Braille sub-pixel canvas: each terminal cell packs a 2×4 dot grid, so
 * lines get four times the vertical resolution of block characters — the
 * smooth, dense look of a Dune time series. Dot bits (U+2800 base):
 * 1 4 / 2 5 / 3 6 / 7 8 → left column 0x01/02/04/40 top-down.
 */
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

function brailleChar(dots: boolean[][]): string {
  let bits = 0
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      if (dots[y]?.[x]) bits |= BRAILLE_BITS[y]?.[x] ?? 0
    }
  }
  return bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits)
}

/** Bresenham on integer pixels; paints every visited pixel-row. */
function plotLine(pixels: Array<Set<number>>, from: { x: number; y: number }, to: { x: number; y: number }, height: number): void {
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  const sx = from.x < to.x ? 1 : -1
  const sy = from.y < to.y ? 1 : -1
  let error = dx - dy
  let x = from.x
  let y = from.y
  for (;;) {
    pixels[x]?.add(Math.min(height - 1, Math.max(0, y)))
    if (x === to.x && y === to.y) break
    const doubled = 2 * error
    if (doubled > -dy) {
      error -= dy
      x += sx
    }
    if (doubled < dx) {
      error += dx
      y += sy
    }
  }
}

/**
 * Dune-style multi-series line chart in braille dots. One canvas of
 * width×height cells holds every series at 2×4 sub-pixel resolution;
 * later series win pixel conflicts so the top series stays visible.
 */
export function renderLines(options: {
  series: DitherSeries[]
  width: number
  height: number
  axisWidth?: number
}): DitherCell[][] {
  const axisWidth = options.axisWidth ?? 6
  const plotWidth = Math.max(4, options.width - axisWidth - 1)
  const height = Math.max(2, options.height)
  const pixelHeight = height * 4
  const max = niceMax(options.series.reduce((top, series) => Math.max(top, ...series.values.map((value) => Math.max(0, value))), 0))
  // One Set of painted pixel-rows per pixel-column per series, then merged.
  const layers = options.series.map((series) => {
    const sampled = sample(series.values, plotWidth * 2)
    const points = sampled.map((value) => {
      const scaled = max > 0 ? Math.max(0, value) / max : 0
      return Math.round((1 - scaled) * (pixelHeight - 1))
    })
    const pixels: Array<Set<number>> = Array.from({ length: plotWidth * 2 }, () => new Set<number>())
    for (let i = 0; i < points.length; i++) {
      const y = points[i]
      if (y === undefined) continue
      pixels[i]?.add(Math.min(pixelHeight - 1, Math.max(0, y)))
      const next = points[i + 1]
      if (next !== undefined) plotLine(pixels, { x: i, y }, { x: i + 1, y: next }, pixelHeight)
    }
    return { series, pixels }
  })

  const rows: DitherCell[][] = []
  for (let cy = 0; cy < height; cy++) {
    const high = ((height - cy) / height) * max
    const label = cy === 0 || cy === height - 1 || cy === Math.floor(height / 2)
      ? axisLabel(high, axisWidth)
      : ' '.repeat(axisWidth)
    const row: DitherCell[] = [...label].map((ch) => ({ ch, color: theme.textMuted }))
    row.push({ ch: cy === height - 1 ? '└' : '│', color: theme.border })
    for (let cx = 0; cx < plotWidth; cx++) {
      const dots: boolean[][] = Array.from({ length: 4 }, () => [false, false])
      let color: string | undefined
      for (const layer of layers) {
        for (let py = 0; py < 4; py++) {
          const pixelY = cy * 4 + py
          if ((layer.pixels[cx * 2]?.has(pixelY)) === true) {
            dots[py]![0] = true
            color = DITHER_COLORS[layer.series.color]
          }
          if ((layer.pixels[cx * 2 + 1]?.has(pixelY)) === true) {
            dots[py]![1] = true
            color = DITHER_COLORS[layer.series.color]
          }
        }
      }
      row.push({ ch: brailleChar(dots), color: color ?? theme.background })
    }
    rows.push(row)
  }
  return rows
}

/**
 * Terminal donut. Cell aspect is ~1:2 (chars are taller than wide), so the
 * grid is two characters wide per row of radius. Slices start at 12 o'clock
 * and run clockwise; zero-value slices are skipped.
 */
export function renderDonut(options: {
  slices: Array<{ value: number; color: DitherColor }>
  height?: number
}): DitherCell[][] {
  const height = Math.max(3, Math.floor(options.height ?? 7))
  const radius = height / 2
  const width = height * 2
  const total = options.slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)
  if (total <= 0) {
    return Array.from({ length: height }, () => Array.from({ length: width }, (): DitherCell => ({ ch: '·', color: theme.border })))
  }
  const bounds: Array<{ from: number; to: number; color: DitherColor }> = []
  let cursor = 0
  for (const slice of options.slices) {
    const share = Math.max(0, slice.value) / total
    if (share <= 0) continue
    bounds.push({ from: cursor, to: cursor + share, color: slice.color })
    cursor += share
  }
  const rows: DitherCell[][] = []
  for (let y = 0; y < height; y++) {
    const row: DitherCell[] = []
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5) / 2 - radius
      const dy = y + 0.5 - radius
      const r = Math.sqrt(dx * dx + dy * dy)
      if (r > radius || r < radius * 0.55) {
        row.push({ ch: ' ', color: theme.background })
        continue
      }
      let angle = Math.atan2(dx, -dy) / (2 * Math.PI)
      if (angle < 0) angle += 1
      const slice = bounds.find((bound) => angle >= bound.from && angle < bound.to) ?? bounds[bounds.length - 1]
      const shade = r > radius * 0.85 ? '▒' : '█'
      row.push({ ch: shade, color: DITHER_COLORS[slice?.color ?? 'grey'] })
    }
    rows.push(row)
  }
  return rows
}

/**
 * Calendar-style intensity grid (GitHub contributions). Values fill
 * column-major — newest column at the right — with the gradient ramp
 * encoding intensity inside one hue.
 */
export function renderHeatmap(options: {
  values: number[]
  columns?: number
  rows?: number
  color: DitherColor
}): DitherCell[][] {
  const rowCount = Math.max(1, Math.floor(options.rows ?? 4))
  const columnCount = Math.max(1, Math.floor(options.columns ?? Math.ceil(options.values.length / rowCount)))
  const max = options.values.reduce((top, value) => Math.max(top, value), 0)
  const cells: DitherCell[] = []
  for (let column = 0; column < columnCount; column++) {
    for (let row = 0; row < rowCount; row++) {
      const index = column * rowCount + row
      const value = options.values[index] ?? 0
      const intensity = max > 0 ? value / max : 0
      const rank = intensity <= 0 ? 0 : Math.min(GRADIENT_RAMP.length, 1 + Math.floor(intensity * GRADIENT_RAMP.length))
      const ch = rank === 0 ? '·' : GRADIENT_RAMP[Math.min(GRADIENT_RAMP.length - 1, rank - 1)] ?? '░'
      cells.push({ ch, color: rank === 0 ? theme.border : DITHER_COLORS[options.color] })
    }
  }
  return Array.from({ length: rowCount }, (_, row) =>
    cells.filter((_, index) => index % rowCount === row),
  )
}

/**
 * Horizontal waterfall for flow breakdowns (fees + bribes − emissions =
 * net). One row per chained step; each bar floats between the running
 * cumulative bounds, so gains build upward and deductions pull back.
 */
export function renderWaterfall(options: {
  steps: Array<{ delta: number; color: DitherColor }>
  width: number
}): DitherCell[][] {
  const width = Math.max(4, options.width)
  const bands: Array<{ from: number; to: number; color: DitherColor }> = []
  let level = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const step of options.steps) {
    const next = level + step.delta
    const from = Math.min(level, next)
    const to = Math.max(level, next)
    bands.push({ from, to, color: step.color })
    min = Math.min(min, from)
    max = Math.max(max, to)
    level = next
  }
  if (bands.length === 0) return []
  const span = Math.max(1e-9, max - min)
  const scale = (value: number) => Math.round(((value - min) / span) * (width - 1))
  return bands.map((band) => {
    const from = scale(band.from)
    const to = scale(band.to)
    return Array.from({ length: width }, (_, x): DitherCell =>
      x >= from && x <= to ? { ch: '█', color: DITHER_COLORS[band.color] } : { ch: ' ', color: theme.background })
  })
}

/**
 * Liquidity map: one dot per pool on normalized axes. Quadrant guides at
 * the midlines make the efficient/inefficient split readable at a glance;
 * later points paint over earlier ones.
 */
export function renderScatter(options: {
  points: Array<{ x: number; y: number; color: DitherColor }>
  width: number
  height: number
  axisWidth?: number
  guides?: boolean
}): DitherCell[][] {
  const axisWidth = options.axisWidth ?? 6
  const plotWidth = Math.max(4, options.width - axisWidth - 1)
  const height = Math.max(3, options.height)
  const maxX = Math.max(...options.points.map((point) => point.x), 1e-9)
  const maxY = Math.max(...options.points.map((point) => point.y), 1e-9)
  const grid: Array<Array<{ ch: string; color: string } | undefined>> = Array.from(
    { length: height },
    () => Array.from({ length: plotWidth }, () => undefined),
  )
  for (const point of options.points) {
    const x = Math.min(plotWidth - 1, Math.max(0, Math.round((point.x / maxX) * (plotWidth - 1))))
    const y = Math.min(height - 1, Math.max(0, Math.round((1 - point.y / maxY) * (height - 1))))
    grid[y]![x] = { ch: '●', color: DITHER_COLORS[point.color] }
  }
  return grid.map((row, y) => {
    const high = ((height - y) / height) * maxY
    const label = y === 0 || y === height - 1 || y === Math.floor(height / 2)
      ? axisLabel(high, axisWidth)
      : ' '.repeat(axisWidth)
    const cells: DitherCell[] = [...label].map((ch) => ({ ch, color: theme.textMuted }))
    cells.push({ ch: y === height - 1 ? '└' : '│', color: theme.border })
    for (let x = 0; x < plotWidth; x++) {
      const point = row[x]
      if (point) {
        cells.push(point)
        continue
      }
      const guide = options.guides === true && (y === Math.floor(height / 2) || x === Math.floor(plotWidth / 2))
      cells.push(guide ? { ch: '·', color: theme.border } : { ch: ' ', color: theme.background })
    }
    return cells
  })
}
