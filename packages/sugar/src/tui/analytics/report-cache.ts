import type { AnalyticsReport } from './load'

type ReportEntry = { report?: AnalyticsReport; promise?: Promise<AnalyticsReport>; startedAt: number }

type ReportStorage = {
  load: (chain: number, update: (report: AnalyticsReport) => void) => Promise<AnalyticsReport>
  read: (chain: number) => AnalyticsReport | undefined
  write: (chain: number, report: AnalyticsReport) => void
}

export function createReportCache(storage: ReportStorage) {
  const entries = new Map<number, ReportEntry>()
  return {
    peek(chain: number) { return entries.get(chain)?.report ?? storage.read(chain) },
    invalidate(chain: number) { entries.delete(chain) },
    load(chain: number, onUpdate?: (report: AnalyticsReport) => void): Promise<AnalyticsReport> {
      const prior = entries.get(chain)
      if (prior?.promise && Date.now() - prior.startedAt < 60_000) {
        if (prior.report) onUpdate?.(prior.report)
        return prior.promise
      }
      const disk = prior?.report ? undefined : storage.read(chain)
      const entry: ReportEntry = { report: prior?.report ?? disk, startedAt: Date.now() }
      entries.set(chain, entry)
      if (disk) onUpdate?.(disk)
      entry.promise = storage.load(chain, snapshot => {
        if (entries.get(chain) !== entry) return
        const merged = disk ? {
          ...snapshot,
          onchain: snapshot.onchain ?? disk.onchain,
          dune: snapshot.dune ?? disk.dune,
          llama: snapshot.llama ?? disk.llama,
          ve: snapshot.ve ?? disk.ve,
        } : snapshot
        entry.report = merged
        onUpdate?.(merged)
      }).then(final => {
        if (entries.get(chain) === entry) {
          entry.report = final
          storage.write(chain, final)
        }
        return final
      }).catch((cause: unknown) => {
        if (entries.get(chain) === entry) entry.promise = undefined
        throw cause
      })
      return entry.promise
    },
  }
}
