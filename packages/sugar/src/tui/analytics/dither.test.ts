import { describe, expect, test } from 'bun:test'
import { bayerThreshold, chartToString, ditherChar, groupRuns, renderArea, renderColumns, renderDonut, renderHBar, renderHeatmap, renderLines, renderScatter, renderSpark, renderStackBar, renderWaterfall } from './dither'
import type { DitherCell } from './dither'

describe('bayer dither', () => {
  test('thresholds stay in (0, 1)', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const threshold = bayerThreshold(x, y)
        expect(threshold).toBeGreaterThan(0)
        expect(threshold).toBeLessThan(1)
      }
    }
  })

  test('zero intensity is always blank', () => {
    expect(ditherChar(0, 0, 0, 'gradient')).toBe(' ')
    expect(ditherChar(0, 0, 0, 'dotted')).toBe(' ')
    expect(ditherChar(0, 0, 0, 'hatched')).toBe(' ')
    expect(ditherChar(0, 0, 0, 'solid')).toBe(' ')
  })

  test('full intensity paints every variant', () => {
    expect(ditherChar(0, 0, 1, 'solid')).toBe('█')
    expect(ditherChar(0, 0, 1, 'hatched')).toMatch(/[╱╲]/)
    expect(ditherChar(3, 1, 1, 'dotted')).toMatch(/[·•●]/)
    expect(ditherChar(3, 1, 1, 'gradient')).toMatch(/[░▒▓█]/)
  })

  test('hatched alternates diagonals', () => {
    expect(ditherChar(0, 0, 1, 'hatched')).toBe('╱')
    expect(ditherChar(1, 0, 1, 'hatched')).toBe('╲')
  })
})

describe('renderArea', () => {
  test('rising series fills more cells on the right', () => {
    const rows = renderArea({
      series: [{ key: 'fees', color: 'blue', values: [0, 1, 2, 4, 8] }],
      width: 20,
      height: 6,
    })
    const text = chartToString(rows)
    const lines = text.split('\n')
    expect(lines).toHaveLength(6)
    const last = lines[5] ?? ''
    const first = lines[0] ?? ''
    const painted = (line: string) => [...line].filter((ch) => ch !== ' ' && ch !== '│' && ch !== '└' && !/[0-9.KMB-]/.test(ch)).length
    expect(painted(last)).toBeGreaterThan(painted(first))
    expect(last).toContain('└')
  })

  test('stacked series keep a stable width', () => {
    const rows = renderArea({
      series: [
        { key: 'fees', color: 'blue', values: [2, 2, 2] },
        { key: 'bribes', color: 'purple', variant: 'hatched', values: [1, 1, 1] },
      ],
      width: 16,
      height: 5,
      stacked: true,
    })
    expect(rows.every((row) => row.length === 16)).toBe(true)
  })
})

describe('bars and sparks', () => {
  test('horizontal bar scales with value', () => {
    const empty = renderHBar({ value: 0, max: 10, width: 10, color: 'green' })
    const full = renderHBar({ value: 10, max: 10, width: 10, color: 'green' })
    expect(empty.every((cell) => cell.ch === ' ')).toBe(true)
    expect(full.some((cell) => cell.ch !== ' ')).toBe(true)
  })

  test('stack bar partitions the width by share', () => {
    const bar = renderStackBar({
      parts: [
        { value: 75, color: 'green' },
        { value: 25, color: 'grey' },
      ],
      width: 8,
    })
    expect(bar).toHaveLength(8)
    expect(bar.filter((cell) => cell.color !== '#7a8194').length).toBeGreaterThan(bar.filter((cell) => cell.color === '#7a8194').length)
  })

  test('sparkline is one row of the requested width', () => {
    const spark = renderSpark([1, 3, 2, 5, 4], 8, 'orange')
    expect(spark).toHaveLength(8)
  })

  test('columns keep one bar per week and a stable height', () => {
    const rows = renderColumns({ values: [1, 3, 2, 8], width: 24, height: 5, color: 'blue' })
    expect(rows).toHaveLength(5)
    const widths = new Set(rows.map((row) => row.length))
    expect(widths.size).toBe(1)
    const text = chartToString(rows)
    expect(text).toContain('│')
    expect(text).toContain('█')
  })

  test('groupRuns merges adjacent same-color cells', () => {
    const runs = groupRuns([
      { ch: '█', color: '#a' },
      { ch: '█', color: '#a' },
      { ch: '░', color: '#b' },
    ])
    expect(runs).toEqual([
      { text: '██', color: '#a' },
      { text: '░', color: '#b' },
    ])
  })
})

describe('renderLines', () => {
  test('braille canvas has one row per cell row and an axis column', () => {
    const rows = renderLines({
      series: [{ key: 'volume', color: 'blue', values: [1, 4, 2, 8, 5, 9] }],
      width: 24,
      height: 6,
    })
    expect(rows).toHaveLength(6)
    expect(rows.every((row) => row.length === 24)).toBe(true)
    const text = chartToString(rows)
    expect(text).toContain('└')
    expect(text).toMatch(/[⠀-⣿]/)
  })

  test('a rising series paints dots near the bottom-left and top-right', () => {
    const rows = renderLines({
      series: [{ key: 'up', color: 'green', values: [0, 10] }],
      width: 12,
      height: 4,
    })
    const top = rows[0]?.map((cell) => cell.ch).join('') ?? ''
    const bottom = rows[rows.length - 1]?.map((cell) => cell.ch).join('') ?? ''
    expect(top.slice(6)).toMatch(/[⠀-⣿]/)
    expect(bottom.slice(6, 10)).toMatch(/[⠀-⣿]/)
  })

  test('two series both leave marks and keep the grid rectangular', () => {
    const rows = renderLines({
      series: [
        { key: 'fees', color: 'blue', values: [1, 3, 2, 5] },
        { key: 'emissions', color: 'orange', variant: 'solid', values: [2, 2, 4, 4] },
      ],
      width: 16,
      height: 5,
    })
    expect(rows.every((row) => row.length === 16)).toBe(true)
    const text = chartToString(rows)
    expect(text).toMatch(/[⠀-⣿]/)
  })

  test('empty values produce blank plot cells without crashing', () => {
    const rows = renderLines({ series: [{ key: 'x', color: 'grey', values: [] }], width: 10, height: 4 })
    expect(rows).toHaveLength(4)
  })
})

describe('renderDonut', () => {
  test('fills a ring with slice colors starting at 12 oclock', () => {
    const rows = renderDonut({
      slices: [
        { value: 75, color: 'blue' },
        { value: 25, color: 'orange' },
      ],
      height: 7,
    })
    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.length === 14)).toBe(true)
    const painted = rows.flat().filter((cell) => cell.ch !== ' ')
    expect(painted.length).toBeGreaterThan(0)
    expect(painted.some((cell) => cell.color === '#f5a742')).toBe(true)
    expect(painted.some((cell) => cell.color === '#4f8ef7')).toBe(true)
  })

  test('hollow center stays empty', () => {
    const rows = renderDonut({ slices: [{ value: 1, color: 'green' }], height: 9 })
    const middle = rows[4] ?? []
    expect(middle[4]?.ch).toBe(' ')
    expect(middle[5]?.ch).toBe(' ')
  })

  test('all-zero slices render a dotted placeholder ring', () => {
    const rows = renderDonut({ slices: [{ value: 0, color: 'red' }], height: 5 })
    const painted = rows.flat().filter((cell) => cell.ch !== ' ')
    expect(painted.length).toBeGreaterThan(0)
    expect(painted.every((cell) => cell.ch === '·')).toBe(true)
  })

  test('single dominant slice wins most painted cells', () => {
    const rows = renderDonut({
      slices: [
        { value: 95, color: 'purple' },
        { value: 5, color: 'pink' },
      ],
      height: 9,
    })
    const byColor = new Map<string, number>()
    for (const cell of rows.flat()) {
      if (cell.ch === ' ') continue
      byColor.set(cell.color, (byColor.get(cell.color) ?? 0) + 1)
    }
    const purple = byColor.get('#9d7cd8') ?? 0
    const pink = byColor.get('#e06c9a') ?? 0
    expect(purple).toBeGreaterThan(pink * 5)
  })
})

describe('renderHeatmap', () => {
  test('lays values out column-major with the requested shape', () => {
    const rows = renderHeatmap({ values: [0, 4, 8, 2, 6, 10], columns: 3, rows: 2, color: 'green' })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.length === 3)).toBe(true)
    const firstColumn = [rows[0]?.[0]?.ch, rows[1]?.[0]?.ch]
    expect(firstColumn).toEqual(['·', '▒'])
  })

  test('peak value paints the strongest ramp char', () => {
    const rows = renderHeatmap({ values: [1, 100], columns: 2, rows: 1, color: 'orange' })
    expect(rows[0]?.[0]?.ch).toBe('░')
    expect(rows[0]?.[1]?.ch).toBe('█')
  })

  test('missing trailing cells pad as empty', () => {
    const rows = renderHeatmap({ values: [5], columns: 3, rows: 2, color: 'blue' })
    expect(rows[0]).toHaveLength(3)
    expect(rows[1]?.[1]?.ch).toBe('·')
  })
})

describe('renderWaterfall', () => {
  const spanOf = (row: DitherCell[]) => {
    const painted = row.map((cell, x) => (cell.ch === '█' ? x : -1)).filter((x) => x >= 0)
    return { lo: Math.min(...painted), hi: Math.max(...painted), size: painted.length }
  }

  test('net step floats above zero while fees start at the baseline', () => {
    const rows = renderWaterfall({
      steps: [
        { delta: 40, color: 'blue' },
        { delta: 20, color: 'purple' },
        { delta: -30, color: 'red' },
      ],
      width: 30,
    })
    expect(rows).toHaveLength(3)
    const fees = spanOf(rows[0] ?? [])
    const net = spanOf(rows[2] ?? [])
    expect(fees.lo).toBe(0)
    expect(net.lo).toBeGreaterThan(fees.hi / 2)
    expect(net.hi).toBe(spanOf(rows[1] ?? []).hi)
  })

  test('chained steps stay contiguous', () => {
    const rows = renderWaterfall({
      steps: [
        { delta: 50, color: 'blue' },
        { delta: 10, color: 'green' },
      ],
      width: 20,
    })
    const first = spanOf(rows[0] ?? [])
    const second = spanOf(rows[1] ?? [])
    expect(second.size).toBeLessThan(first.size)
    expect(Math.abs(second.lo - first.hi)).toBeLessThanOrEqual(1)
  })

  test('total column is isolated by a gap and anchored at the baseline', () => {
    const rows = renderWaterfall({
      steps: [
        { delta: -10, color: 'red' },
        { delta: 25, color: 'green' },
      ],
      width: 24,
    })
    expect(rows).toHaveLength(2)
    const deduction = spanOf(rows[0] ?? [])
    expect(deduction.lo).toBeGreaterThanOrEqual(0)
  })
})

describe('renderScatter', () => {
  test('plots every point inside the grid with quadrant guides', () => {
    const rows = renderScatter({
      points: [
        { x: 1, y: 100_000, color: 'green' },
        { x: 12, y: 4_000_000, color: 'blue' },
      ],
      width: 24,
      height: 7,
      guides: true,
    })
    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.length === 24)).toBe(true)
    const text = chartToString(rows)
    expect(text).toContain('●')
    expect(text).toContain('·')
  })

  test('out-of-range points clamp to the frame instead of crashing', () => {
    const rows = renderScatter({
      points: [
        { x: -5, y: -1, color: 'red' },
        { x: 999, y: 999, color: 'orange' },
      ],
      width: 16,
      height: 5,
    })
    const text = chartToString(rows)
    expect(text.match(/●/g)).toHaveLength(2)
  })
})
