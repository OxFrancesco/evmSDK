import { expect, test } from 'bun:test'
import { createReportCache } from './report-cache'
import type { AnalyticsReport } from './load'

const report = (name: string): AnalyticsReport => ({ chain: 8453, chainName: name, loadedAt: 100, errors: [] })

test('invalidated loads cannot replace newer memory or disk data even with equal timestamps', async () => {
  const pending: Array<ReturnType<typeof Promise.withResolvers<AnalyticsReport>>> = []
  const updates: Array<(report: AnalyticsReport) => void> = []
  let disk: AnalyticsReport | undefined
  const cache = createReportCache({ read: () => disk, write: (_, value) => { disk = value }, load: (_, update) => {
    const task = Promise.withResolvers<AnalyticsReport>(); pending.push(task); updates.push(update); return task.promise
  } })
  const oldUpdates: AnalyticsReport[] = []
  const old = cache.load(8453, value => oldUpdates.push(value))
  cache.invalidate(8453)
  const current = cache.load(8453)
  pending[1]!.resolve(report('new'))
  await current
  updates[0]!(report('old partial'))
  pending[0]!.resolve(report('old'))
  expect(await old).toEqual(report('old'))
  expect(oldUpdates).toEqual([])
  expect(cache.peek(8453)).toEqual(report('new'))
  expect(disk).toEqual(report('new'))
})
