import { useEffect, useState } from 'react'
import { useRenderer } from '@opentui/react'

/**
 * Aerodrome mark: six ribbons stacked top to bottom, each one swept along a
 * curve so the left ends converge into a sharp tip between the white and red
 * ribbons and the right ends fan out. Rendered on a half-column grid with
 * upper-half blocks so the gaps between ribbons read as thin lines.
 */
const COLORS = ['#5b6b9c', '#2f5ee6', '#7fb2ff', '#eef0f5', '#ef4a2f', '#b8352a']
const ROWS = COLORS.length
const TIP = (ROWS - 1) / 2
const SWEEP = 1.4
const WIDTH = 22

const FRAME_MS = 40
const STAGGER_FRAMES = 3
const INTRO_FRAMES = 18
const SWEEP_FRAMES = 30
const SWEEP_EVERY_MS = 6000

export type Phase = { mode: 'intro' | 'idle' | 'sweep'; frame: number }

const easeOut = (t: number) => 1 - (1 - t) ** 3

/** Left edge of ribbon `row`, in columns. Curves outward away from the tip. */
const leftEdge = (row: number) => SWEEP * Math.abs(row - TIP) ** 1.5
/** Ribbons near the tip are shorter, so the right ends fan out like the left. */
const rightEdge = (row: number) => leftEdge(row) + 9 + leftEdge(row) * 0.35

/** Mix a hex color toward white by `amount` (0..1). */
function lighten(hex: string, amount: number): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16)
    return Math.round(value + (255 - value) * amount).toString(16).padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

/** During the intro each ribbon streaks in from the right; this is its reveal edge. */
function revealEdge(row: number, frame: number): number {
  const local = Math.max(0, frame - row * STAGGER_FRAMES)
  return WIDTH * (1 - easeOut(Math.min(1, local / INTRO_FRAMES)))
}

function usePhase(animate: boolean): Phase {
  const renderer = useRenderer()
  const [phase, setPhase] = useState<Phase>({ mode: animate ? 'intro' : 'idle', frame: 0 })
  useEffect(() => {
    if (!animate) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = false
    let mode: 'intro' | 'sweep' = 'intro'
    let length = INTRO_FRAMES + ROWS * STAGGER_FRAMES
    let startedAt = performance.now()
    const stop = () => {
      if (!live) return
      live = false
      renderer.removeFrameCallback(tick)
      renderer.dropLive()
    }
    const tick = async () => {
      const frame = (performance.now() - startedAt) / FRAME_MS
      if (frame < length) return setPhase({ mode, frame })
      stop()
      setPhase({ mode: 'idle', frame: 0 })
      timer = setTimeout(() => {
        mode = 'sweep'
        length = SWEEP_FRAMES
        startedAt = performance.now()
        start()
      }, SWEEP_EVERY_MS)
    }
    const start = () => {
      setPhase({ mode, frame: 0 })
      renderer.setFrameCallback(tick)
      live = true
      renderer.requestLive()
    }
    start()
    return () => {
      stop()
      if (timer) clearTimeout(timer)
    }
  }, [animate, renderer])
  return animate ? phase : { mode: 'idle', frame: 0 }
}

/**
 * Ribbons are 2 pixels tall with a 1 pixel gap on a grid where each cell holds
 * two pixel rows, so a cell is fully, top-, or bottom-covered by one ribbon.
 */
const RIBBON_PITCH = 3
const RIBBON_THICKNESS = 2
export const MARK_ROWS = Math.ceil((ROWS * RIBBON_PITCH - 1) / 2)

const ribbonAtPixel = (pixelRow: number) =>
  pixelRow % RIBBON_PITCH < RIBBON_THICKNESS ? Math.floor(pixelRow / RIBBON_PITCH) : null

const GLYPHS = {
  full: { both: '█', left: '▌', right: '▐' },
  top: { both: '▀', left: '▘', right: '▝' },
  bottom: { both: '▄', left: '▖', right: '▗' },
} as const
type Vertical = keyof typeof GLYPHS

/** Which ribbon a cell row belongs to and which half of the cell it fills. */
function ribbonAtCell(cellRow: number): { ribbon: number; vertical: Vertical } | null {
  const top = ribbonAtPixel(cellRow * 2)
  const bottom = ribbonAtPixel(cellRow * 2 + 1)
  if (top !== null && bottom !== null) return { ribbon: top, vertical: 'full' }
  if (top !== null) return { ribbon: top, vertical: 'top' }
  if (bottom !== null) return { ribbon: bottom, vertical: 'bottom' }
  return null
}

/** Glyph for a cell given how much of its left and right halves the ribbon covers. */
function glyphFor(vertical: Vertical, start: number, end: number, column: number): string | null {
  const left = Math.min(column + 0.5, end) - Math.max(column, start)
  const right = Math.min(column + 1, end) - Math.max(column + 0.5, start)
  const hasLeft = left >= 0.25
  const hasRight = right >= 0.25
  if (hasLeft && hasRight) return GLYPHS[vertical].both
  if (hasLeft) return GLYPHS[vertical].left
  if (hasRight) return GLYPHS[vertical].right
  return null
}

function cellColor(row: number, column: number, phase: Phase): string {
  const base = COLORS[row]
  if (phase.mode === 'intro') {
    const distance = column - revealEdge(row, phase.frame)
    return distance < 3 ? lighten(base, 0.7 - distance * 0.2) : base
  }
  if (phase.mode === 'sweep') {
    const position = (phase.frame / SWEEP_FRAMES) * (WIDTH + ROWS * 2) - ROWS
    const distance = Math.abs(column - row * 0.8 - position)
    return distance < 2.5 ? lighten(base, 0.55 * (1 - distance / 2.5)) : base
  }
  return base
}

export type MarkCell = { glyph: string; color: string } | null

/** The mark as a grid of colored cells for one animation phase; `null` is empty. */
export function renderMark(phase: Phase = { mode: 'idle', frame: 0 }): MarkCell[][] {
  return Array.from({ length: MARK_ROWS }, (_, cellRow) => {
    const cell = ribbonAtCell(cellRow)
    if (!cell) return Array.from({ length: WIDTH }, () => null)
    const { ribbon, vertical } = cell
    const start = Math.max(leftEdge(ribbon), phase.mode === 'intro' ? revealEdge(ribbon, phase.frame) : 0)
    const end = rightEdge(ribbon)
    return Array.from({ length: WIDTH }, (_, column) => {
      const glyph = glyphFor(vertical, start, end, column)
      return glyph ? { glyph, color: cellColor(ribbon, column, phase) } : null
    })
  })
}

export function AeroMark(props: { animate?: boolean }) {
  const phase = usePhase(props.animate !== false)
  return (
    <box flexDirection="column" flexShrink={0} width={WIDTH} height={MARK_ROWS}>
      {renderMark(phase).map((cells, row) => (
        <text key={row}>
          {cells.map((cell, column) => (cell ? <span key={column} fg={cell.color}>{cell.glyph}</span> : ' '))}
        </text>
      ))}
    </box>
  )
}
