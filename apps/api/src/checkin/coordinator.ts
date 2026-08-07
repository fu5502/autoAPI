import type { CheckinResult, CheckinRun, RunTrigger } from './types.js'
import { AppDatabase } from './db.js'
import { CheckinBalanceSync } from './channel-balance.js'
import { EventBus } from './events.js'
import { NewApiService } from './new-api.js'
import { TelegramNotifier } from './telegram.js'

export class CheckinCoordinator {
  private activeRun: CheckinRun | null = null
  private readonly retryTimers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly db: AppDatabase,
    private readonly newApi: NewApiService,
    private readonly events: EventBus,
    private readonly telegram: TelegramNotifier,
    private readonly balanceSync?: CheckinBalanceSync,
  ) {}

  getActiveRun() {
    return this.activeRun
  }

  async run(trigger: RunTrigger, siteIds?: number[], retryAttempt = 0): Promise<CheckinRun> {
    if (this.activeRun) throw new Error('已有签到任务正在运行')
    const explicitlySelectedByUser = trigger === 'manual' && Boolean(siteIds?.length)
    const candidates = this.db.listSites().filter((site) => {
      if (siteIds && !siteIds.includes(site.id)) return false
      if (explicitlySelectedByUser || site.enabled) return true
      return trigger === 'scheduled' || (trigger === 'retry' && Boolean(siteIds?.length))
    })
    if (candidates.length === 0) throw new Error('没有可执行的站点')

    const run = this.db.startRun(trigger)
    this.activeRun = run
    this.events.emit({ type: 'run_started', title: '签到任务已开始', message: `正在处理 ${candidates.length} 个站点`, data: { runId: run.id } })
    const failedSiteIds: number[] = []
    let success = 0
    let failed = 0
    let skipped = 0

    try {
      for (const site of candidates) {
      const balanceOnly = trigger !== 'manual' && !site.enabled
        let result = balanceOnly
          ? await this.newApi.refreshBalanceSite(site, run.id)
          : await this.newApi.checkinSite(site, run.id)
        // A manual click should still refresh the account balance when the
        // site does not expose a usable check-in endpoint. This covers New
        // API installations such as aixoras.com where /api/user/checkin is
        // absent or check-in is disabled, without changing scheduled runs.
        if (!balanceOnly && shouldRefreshBalanceAfterCheckin(result)) {
          result = await this.newApi.refreshBalanceSite(site, run.id)
        }
        const { id: _id, siteName: _siteName, ...storedResult } = result
        this.db.applyResult(site.id, storedResult)
        await this.balanceSync?.syncSite(site.id).catch((error) => {
          this.events.emit({
            type: 'state_changed',
            title: '渠道余额同步失败',
            message: `${site.name}: ${error instanceof Error ? error.message : '未知错误'}`,
          })
        })

        if (['success', 'already_checked'].includes(result.status)) success += 1
        else if (result.status === 'disabled') skipped += 1
        else {
          failed += 1
          if (result.status === 'failed') failedSiteIds.push(site.id)
        }

        this.events.emit({
          type: 'site_result',
          title: resultTitle(result),
          message: `${site.name}: ${result.message}`,
          data: { result, siteId: site.id, runId: run.id },
        })
      }
    } finally {
      const completed = this.db.completeRun(run.id, { success, failed, skipped })!
      this.activeRun = null
      this.events.emit({
        type: 'run_completed',
        title: completed.status === 'completed' ? '签到任务完成' : '签到任务已结束',
        message: `成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}`,
        data: { run: completed },
      })
      await this.telegram.notifyRun(completed, this.db.listResults({ runId: run.id, limit: 500 }))
        .catch((error) => {
          this.events.emit({
            type: 'state_changed',
            title: 'Telegram 通知失败',
            message: error instanceof Error ? error.message : '未知错误',
          })
        })
      this.scheduleRetries(failedSiteIds, retryAttempt)
    }
    return this.db.getRun(run.id)!
  }

  stop() {
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
  }

  private scheduleRetries(siteIds: number[], retryAttempt: number) {
    if (siteIds.length === 0) return
    const settings = this.db.getSettings()
    if (retryAttempt >= settings.retryCount) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      void this.run('retry', siteIds, retryAttempt + 1).catch(() => undefined)
    }, settings.retryDelayMinutes * 60_000)
    timer.unref?.()
    this.retryTimers.add(timer)
  }
}

function resultTitle(result: CheckinResult): string {
  if (result.status === 'success') return '签到成功'
  if (result.status === 'already_checked') return '今日已签到'
  if (result.status === 'manual_required') return '需要人工处理'
  if (result.status === 'disabled') return '站点未启用签到'
  return '签到失败'
}

function shouldRefreshBalanceAfterCheckin(result: CheckinResult): boolean {
  if (result.status === 'disabled') return true
  if (result.status !== 'failed') return false
  return /^(?:not found|method not allowed|未找到|不存在)$/i.test(result.message.trim())
    || /(?:签到|check[-_ ]?in).*(?:404|不存在|未启用|不支持|未开放|不可用)/i.test(result.message)
}
