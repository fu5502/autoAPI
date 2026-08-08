import type { EventBus } from './events.js'

export type RunProgressLevel = 'info' | 'success' | 'warn' | 'error'

export interface RunProgressEntry {
  id: string
  ts: string
  runId: number
  siteId: number | null
  siteName: string | null
  operation: 'checkin' | 'balance_refresh' | null
  level: RunProgressLevel
  message: string
}

const maxEntriesPerRun = 300
const maxRuns = 5

/**
 * In-memory progress trail for check-in and balance refresh runs. Entries are
 * pushed to connected admins over SSE and kept briefly so a page that joins
 * mid-run can fetch them through GET /admin/checkin/progress/:runId.
 */
export class RunProgressLog {
  private readonly runs = new Map<number, RunProgressEntry[]>()
  private readonly runOrder: number[] = []
  private sequence = 0

  constructor(private readonly events: EventBus) {}

  add(input: {
    runId: number
    message: string
    siteId?: number | null
    siteName?: string | null
    operation?: 'checkin' | 'balance_refresh' | null
    level?: RunProgressLevel
  }): RunProgressEntry {
    const entry: RunProgressEntry = {
      id: `${Date.now()}-${(this.sequence += 1)}`,
      ts: new Date().toISOString(),
      runId: input.runId,
      siteId: input.siteId ?? null,
      siteName: input.siteName ?? null,
      operation: input.operation ?? null,
      level: input.level ?? 'info',
      message: input.message,
    }
    const entries = this.runs.get(input.runId) ?? []
    entries.push(entry)
    if (entries.length > maxEntriesPerRun) entries.splice(0, entries.length - maxEntriesPerRun)
    if (!this.runs.has(input.runId)) {
      this.runs.set(input.runId, entries)
      this.runOrder.push(input.runId)
      if (this.runOrder.length > maxRuns) {
        const oldest = this.runOrder.shift()
        if (oldest !== undefined) this.runs.delete(oldest)
      }
    }
    this.events.emit({
      type: 'run_progress',
      title: entry.message,
      message: entry.message,
      data: { runId: input.runId, entry },
    })
    return entry
  }

  list(runId: number): RunProgressEntry[] {
    return [...(this.runs.get(runId) ?? [])]
  }
}
