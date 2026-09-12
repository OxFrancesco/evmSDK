/**
 * Optional Telegram notifications through the local `buddytg` CLI
 * (`buddytg notify` sends a push via the user's own bot). Notification
 * failures are logged and swallowed — observability must never stall or
 * fail the rebalance loop.
 */

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export type AlmNotifier = (html: string) => Promise<void>

export function noopNotifier(): AlmNotifier {
  return async () => {}
}

export async function runNotification(command: string[], timeoutMs = 10_000): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' })
  const reader = child.stderr.getReader()
  let stderr = ''
  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const drain = (async () => {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        if (stderr.length < 4096) stderr += decoder.decode(next.value).slice(0, 4096 - stderr.length)
      }
    } catch { /* The pipe is cancelled after the child exits. */ }
  })()
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1000)
  }, timeoutMs)
  try {
    const code = await child.exited
    await reader.cancel().catch(() => {})
    await drain
    return { code, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (forceKill) clearTimeout(forceKill)
  }
}

export function buddytgNotifier(log: (line: string) => void = console.error): AlmNotifier {
  return async (html: string) => {
    try {
      const result = await runNotification(['buddytg', 'notify', '--html', html])
      if (result.timedOut || result.code !== 0) {
        log(`telegram notification failed: ${result.timedOut ? 'timed out' : result.stderr.trim().split('\n')[0] || 'buddytg exited non-zero'}`)
      }
    } catch (cause) {
      log(`telegram notification failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

export function rebalanceNotification(input: {
  dryRun: boolean
  poolSymbol: string
  chainName: string
  strategy: string
  reason: string
  oldRange: string
  newRange: string
  hashes?: string[]
}): string {
  const title = input.dryRun ? '🐝 aero serve would rebalance (dry-run)' : '🐝 aero serve rebalanced a position'
  const lines = [
    `<b>${title}</b>`,
    '',
    `<b>Pool:</b> <code>${escapeHtml(input.poolSymbol)}</code> (${escapeHtml(input.chainName)})`,
    `<b>Strategy:</b> ${escapeHtml(input.strategy)}`,
    `<b>Range:</b> ${escapeHtml(input.oldRange)} → ${escapeHtml(input.newRange)}`,
    `<b>Why:</b> ${escapeHtml(input.reason)}`,
  ]
  if (input.hashes && input.hashes.length > 0) {
    lines.push(`<b>Txs:</b> ${input.hashes.map((hash) => `<code>${escapeHtml(hash)}</code>`).join(', ')}`)
  }
  return lines.join('\n')
}

export function errorNotification(input: { poolSymbol: string; phase: string; message: string }): string {
  return [
    '<b>⚠️ aero serve needs attention</b>',
    '',
    `<b>Pool:</b> <code>${escapeHtml(input.poolSymbol)}</code>`,
    `<b>Phase:</b> ${escapeHtml(input.phase)}`,
    `<b>Error:</b> ${escapeHtml(input.message)}`,
  ].join('\n')
}

export function compoundNotification(input: { dryRun: boolean; poolSymbol: string; amountDecimal: number; symbol: string; hashes?: string[] }): string {
  const title = input.dryRun ? '🐝 aero serve would compound (dry-run)' : '🐝 aero serve compounded emissions'
  const lines = [
    `<b>${title}</b>`,
    '',
    `<b>Pool:</b> <code>${escapeHtml(input.poolSymbol)}</code>`,
    `<b>Emissions:</b> ${escapeHtml(`${input.amountDecimal} ${input.symbol}`)}`,
  ]
  if (input.hashes && input.hashes.length > 0) {
    lines.push(`<b>Txs:</b> ${input.hashes.map((hash) => `<code>${escapeHtml(hash)}</code>`).join(', ')}`)
  }
  return lines.join('\n')
}
