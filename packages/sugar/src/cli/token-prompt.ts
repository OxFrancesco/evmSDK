import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Terminal from 'effect/Terminal'
import * as Prompt from 'effect/unstable/cli/Prompt'
import { fuzzyScore } from '../fuzzy'
import type { TokenChoice } from '../token-catalog'

/**
 * Interactive terminal token finder: type to fuzzy-filter the whitelisted
 * Aerodrome catalog, ↑↓ to move, Enter to pick, Esc to cancel. Rendered as
 * a custom effect/cli Prompt so raw mode, ctrl+c quit, and frame clearing
 * behave exactly like the package's other prompts.
 */

export type TokenPick = { canceled: true } | { canceled: false; choice: TokenChoice }

type PickerState = { query: string; index: number }

// The prompt loop matches on these _tag strings (see Prompt.runLoop); the
// public module does not export action constructors, so build the shapes.
const Beep = { _tag: 'Beep' } as const
const nextFrame = (state: PickerState) => ({ _tag: 'NextFrame', state }) as const
const submit = (value: TokenPick) => ({ _tag: 'Submit', value }) as const

/** Rank choices against the query; empty queries keep the catalog order. */
export function filterChoices(choices: TokenChoice[], query: string): TokenChoice[] {
  const text = query.trim()
  if (text === '') return choices
  const scored: Array<{ choice: TokenChoice; score: number }> = []
  for (const choice of choices) {
    const score = fuzzyScore(text, `${choice.title} ${choice.description}`)
    if (score !== undefined) scored.push({ choice, score })
  }
  return scored.sort((left, right) => left.score - right.score).map((entry) => entry.choice)
}

export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return Math.max(0, Math.min(length - 1, current + delta))
}

const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'

/**
 * ANSI-free measurement: every logical line is stripped to one physical row,
 * which keeps frame clearing exact even when the terminal would wrap.
 */
function truncate(line: string, columns: number): string {
  // Unknown width (piped or exotic terminals) falls back to the 80-column
  // assumption rather than shredding every line.
  const width = Math.max(10, (columns > 1 ? columns : 80) - 1)
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`
}

export type PickerOptions = {
  message: string
  choices: TokenChoice[]
  initialQuery?: string
  maxPerPage?: number
}

function frameLines(state: PickerState, options: PickerOptions, columns: number): string[] {
  const filtered = filterChoices(options.choices, state.query)
  const perPage = options.maxPerPage ?? 10
  const start = Math.max(0, Math.min(state.index - perPage + 2, filtered.length - perPage))
  const lines = [
    truncate(`${CYAN}?${RESET} ${options.message} ${DIM}(↑↓ move · enter select · esc cancel)${RESET}`, columns),
    state.query === ''
      ? truncate(`${CYAN}❯${RESET} ${DIM}type to search ${options.choices.length} listed tokens${RESET}`, columns)
      : truncate(`${CYAN}❯${RESET} ${state.query}`, columns),
  ]
  const visible = filtered.slice(start, start + perPage)
  visible.forEach((choice, at) => {
    const active = start + at === state.index
    const prefix = active ? `${CYAN}›${RESET}` : ' '
    lines.push(truncate(`${prefix} ${BOLD}${choice.title}${RESET}  ${DIM}${choice.description}${RESET}`, columns))
  })
  if (filtered.length > perPage) {
    lines.push(truncate(`${DIM}… ${filtered.length - perPage} more${RESET}`, columns))
  }
  return lines
}

/** Row count the frame occupies, used by the clearer to erase exactly once. */
function frameRows(state: PickerState, options: PickerOptions, columns: number): number {
  return frameLines(state, options, columns).length
}
export function tokenPickPrompt(options: PickerOptions): Prompt.Prompt<TokenPick> {
  const initialState: PickerState = { query: options.initialQuery ?? '', index: 0 }
  return Prompt.custom(initialState, {
    render: (state, action) =>
      Effect.gen(function* () {
        const terminal = yield* Terminal.Terminal
        const columns = yield* terminal.columns
        if (action._tag === 'Submit') {
          const answer = action.value.canceled
            ? `${DIM}canceled${RESET}`
            : `${BOLD}${action.value.choice.title}${RESET} ${DIM}(${action.value.choice.token.tokenAddress})${RESET}`
          return `${CYAN}✔${RESET} ${options.message} ${answer}\n`
        }
        return frameLines(state, options, columns).join('\n')
      }),
    process: (input, state) =>
      Effect.sync(() => {
        const length = () => filterChoices(options.choices, state.query).length
        if (input.key.ctrl && input.key.name === 'u') return nextFrame({ query: '', index: 0 })
        switch (input.key.name) {
          case 'escape':
            return submit({ canceled: true })
          case 'up':
            return nextFrame({ ...state, index: moveIndex(state.index, -1, length()) })
          case 'down':
          case 'tab':
            return nextFrame({ ...state, index: moveIndex(state.index, input.key.shift ? -1 : 1, length()) })
          case 'k':
            if (input.key.ctrl) return nextFrame({ ...state, index: moveIndex(state.index, -1, length()) })
            break
          case 'j':
            if (input.key.ctrl) return nextFrame({ ...state, index: moveIndex(state.index, 1, length()) })
            break
          case 'pageup':
            return nextFrame({ ...state, index: moveIndex(state.index, -(options.maxPerPage ?? 10), length()) })
          case 'pagedown':
            return nextFrame({ ...state, index: moveIndex(state.index, options.maxPerPage ?? 10, length()) })
          case 'backspace':
          case 'delete':
            return nextFrame({ ...state, query: state.query.slice(0, -1), index: 0 })
          case 'enter':
          case 'return':
          case 'linefeed': {
            const choice = filterChoices(options.choices, state.query)[state.index]
            return choice ? submit({ canceled: false, choice }) : Beep
          }
          default:
            break
        }
        if (input.key.ctrl || input.key.meta) return Beep
        const typed = Option.getOrUndefined(input.input)
        if (typed !== undefined && typed.length > 0 && typed >= ' ') {
          return nextFrame({ ...state, query: state.query + typed, index: 0 })
        }
        return Beep
      }),
    // Runs against the previously rendered state; submissions add one line.
    clear: (state, action) =>
      Effect.gen(function* () {
        const terminal = yield* Terminal.Terminal
        const columns = yield* terminal.columns
        const rows = frameRows(state, options, columns) + (action._tag === 'Submit' ? 1 : 0)
        if (rows <= 1) return '\x1b[2K\x1b[1G'
        return `\x1b[${rows - 1}A\x1b[1G\x1b[J`
      }),
  })
}
