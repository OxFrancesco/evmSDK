import { resolve } from 'node:path'

const cli = Bun.argv[2] ? resolve(Bun.argv[2]) : resolve(import.meta.dir, '../src/cli.ts')
const runs = Number(Bun.argv[3] ?? 3)
const results: { startupMs: number; frameGapsMs: number[]; exitCode: number }[] = []

for (let run = 0; run < runs; run++) {
  const started = performance.now()
  const frames: number[] = []
  let startup: number | undefined
  let buffered = ''
  const decoder = new TextDecoder()
  const child = Bun.spawn([process.execPath, cli, 'tui'], {
    cwd: process.env.HOME,
    terminal: {
      cols: 132,
      rows: 40,
      data(terminal, data) {
        const chunk = decoder.decode(data, { stream: true })
        const elapsed = performance.now() - started
        buffered += chunk
        if (startup === undefined && buffered.includes('trade through the best route')) startup = elapsed
        if (chunk.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
        if (chunk.includes('\x1b[c')) terminal.write('\x1b[?1;2c')
        let end: number
        while ((end = buffered.indexOf('\x1b[?2026l')) !== -1) {
          frames.push(elapsed)
          buffered = buffered.slice(end + '\x1b[?2026l'.length)
        }
      },
    },
  })
  try {
    await Bun.sleep(10_000)
    child.terminal?.write('\x03')
    const timeout = setTimeout(() => child.kill(), 3000)
    const exitCode = await child.exited
    clearTimeout(timeout)
    if (startup === undefined) throw new Error(`Run ${run + 1}: home screen did not render`)
    const homeAt = startup
    // Ignore terminal negotiation and the intentional idle pause after the intro.
    const intro = frames.filter((at) => at >= homeAt + 100 && at <= homeAt + 1200)
    const frameGapsMs = intro.slice(1).map((at, index) => at - intro[index])
    if (frameGapsMs.length < 10) throw new Error(`Run ${run + 1}: too few animation frames`)
    results.push({ startupMs: startup, frameGapsMs, exitCode })
    const sorted = frameGapsMs.toSorted((left, right) => left - right)
    console.log(JSON.stringify({ run: run + 1, startupMs: Math.round(startup), frames: intro.length,
      p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]), maxGapMs: Math.round(Math.max(...sorted)), exitCode }))
  } finally {
    child.kill()
    child.terminal?.close()
  }
}

if (results.some((run) => {
  const sorted = run.frameGapsMs.toSorted((left, right) => left - right)
  return run.exitCode !== 0 || Math.max(...sorted) > 80 || sorted[Math.floor(sorted.length * 0.95)] > 34
})) process.exitCode = 1
