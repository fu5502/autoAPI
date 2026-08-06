import { AppDatabase } from './db.js'
import { CheckinCoordinator } from './coordinator.js'
import { EventBus } from './events.js'
import { localDateKey } from './utils.js'

export class DailyScheduler {
  private timer: NodeJS.Timeout | null = null
  private nextRunAt: string | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly coordinator: CheckinCoordinator,
    private readonly events: EventBus,
  ) {}

  start() {
    this.reschedule()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextRunAt = null
  }

  reschedule() {
    this.stop()
    const settings = this.db.getSettings()
    if (!settings.scheduleEnabled) return

    // 每天只跑一次：把最近一次定时签到的时间交给 chooseNextRun，
    // 当天已经跑过就直接排到第二天，避免「跑完 → 在剩余窗口里再排一次」的连环触发，
    // 也避免在窗口时间段内重启服务时立刻又补跑一次。
    const next = chooseNextRun(
      new Date(),
      settings.scheduleWindowStart,
      settings.scheduleWindowEnd,
      Math.random,
      this.db.getLastRunStartedAt('scheduled'),
      settings.timezone,
    )
    this.nextRunAt = next.toISOString()
    const delay = Math.max(1000, next.getTime() - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextRunAt = null
      void this.coordinator.run('scheduled')
        .catch((error) => {
          this.events.emit({
            type: 'run_completed',
            title: '定时签到未执行',
            message: error instanceof Error ? error.message : '未知错误',
          })
        })
        .finally(() => this.reschedule())
    }, delay)
    this.timer.unref?.()
  }

  getNextRunAt() {
    return this.nextRunAt
  }

  isRunning() {
    return this.timer !== null
  }
}

/**
 * 计算下一次定时签到的时间。
 *
 * 每天只执行一次：`lastRunAt`（最近一次 scheduled 任务的开始时间，ISO 字符串）
 * 落在本地时间的今天时，直接排到明天的窗口内，不在当天剩余窗口里补跑。
 */
export function chooseNextRun(
  now: Date,
  windowStart: string,
  windowEnd: string,
  random = Math.random,
  lastRunAt?: string | null,
  timeZone = 'Asia/Shanghai',
): Date {
  const startMinutes = parseTime(windowStart, 8 * 60)
  const endMinutes = Math.max(startMinutes + 1, parseTime(windowEnd, 10 * 60))
  const localNow = zonedParts(now, timeZone)
  const currentMinutes = localNow.hour * 60 + localNow.minute

  let minMinute: number
  let dayOffset = 0
  if (isSameLocalDay(now, lastRunAt, timeZone)) {
    // 今天已经跑过定时签到了，直接排明天。
    dayOffset = 1
    minMinute = startMinutes
  } else if (currentMinutes < startMinutes) {
    minMinute = startMinutes
  } else if (currentMinutes < endMinutes) {
    minMinute = currentMinutes + 1
  } else {
    dayOffset = 1
    minMinute = startMinutes
  }

  const selectedMinute = minMinute + Math.floor(random() * Math.max(1, endMinutes - minMinute))
  const targetDay = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + dayOffset))
  return zonedDateToInstant({
    year: targetDay.getUTCFullYear(),
    month: targetDay.getUTCMonth() + 1,
    day: targetDay.getUTCDate(),
    hour: Math.floor(selectedMinute / 60),
    minute: selectedMinute % 60,
  }, timeZone)
}

function isSameLocalDay(now: Date, isoTimestamp: string | null | undefined, timeZone: string): boolean {
  if (!isoTimestamp) return false
  const last = new Date(isoTimestamp)
  if (Number.isNaN(last.getTime())) return false
  return localDateKey(last, timeZone) === localDateKey(now, timeZone)
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function zonedDateToInstant(parts: ZonedParts, timeZone: string): Date {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  const firstGuess = new Date(localAsUtc)
  const offset = localWallClockAsUtc(firstGuess, timeZone) - firstGuess.getTime()
  const adjusted = new Date(localAsUtc - offset)
  const correctedOffset = localWallClockAsUtc(adjusted, timeZone) - adjusted.getTime()
  return new Date(localAsUtc - correctedOffset)
}

function localWallClockAsUtc(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

function parseTime(value: string, fallback: number): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return fallback
  return hours * 60 + minutes
}
