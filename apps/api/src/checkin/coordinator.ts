import type { CheckinResult, CheckinRun, RunTrigger } from './types.js'
import { AppDatabase } from './db.js'
import { CheckinBalanceSync, type CheckinBalanceSyncOptions } from './channel-balance.js'
import { EventBus } from './events.js'
import type { LocalExecutionOperation, LocalExecutionReport } from './local-execution.js'
import { NewApiService } from './new-api.js'
import type { RunProgressLog } from './progress.js'
import { TelegramNotifier } from './telegram.js'
import { quotaToAmount, roundAmount } from './utils.js'

export class CheckinCoordinator {
  private activeRun: CheckinRun | null = null
  private cancelled = false
  private cancelledSiteIds = new Set<number>()
  private currentSiteId: number | null = null
  private readonly retryTimers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly db: AppDatabase,
    private readonly newApi: NewApiService,
    private readonly events: EventBus,
    private readonly telegram: TelegramNotifier,
    private readonly balanceSync?: CheckinBalanceSync,
    private readonly progress?: RunProgressLog,
  ) {}

  getActiveRun() {
    return this.activeRun
  }

  recoverStaleRuns(): number {
    const staleRuns = this.db.listRecentRuns(200).filter((run) => run.status === 'running')
    for (const run of staleRuns) {
      this.db.cancelRun(run.id, {
        success: run.successCount,
        failed: run.failedCount,
        skipped: run.skippedCount,
      })
    }
    for (const site of this.db.listSites().filter((candidate) => candidate.lastStatus === 'running')) {
      this.db.recoverSiteRunning(site.id)
    }
    return staleRuns.length
  }

  async cancelActiveRun(runId?: number): Promise<CheckinRun | null> {
    const active = this.activeRun
    if (active) {
      if (runId !== undefined && active.id !== runId) return this.db.getRun(runId)
      this.cancelled = true
      this.logProgress(active.id, {
        level: 'warn',
        message: '收到终止请求，正在等待当前站点结束',
      })
      await this.newApi.cancelActiveTask().catch(() => undefined)
      return this.db.getRun(active.id)
    }

    const stale = this.db.listRecentRuns(200)
      .find((run) => run.status === 'running' && (runId === undefined || run.id === runId))
    if (!stale) return null
    this.db.cancelRun(stale.id, {
      success: stale.successCount,
      failed: stale.failedCount,
      skipped: stale.skippedCount,
    })
    for (const site of this.db.listSites().filter((candidate) => candidate.lastStatus === 'running')) {
      this.db.recoverSiteRunning(site.id)
    }
    return this.db.getRun(stale.id)
  }

  async cancelActiveSite(runId: number, siteId: number): Promise<CheckinRun | null> {
    const active = this.activeRun
    if (active && active.id === runId) {
      this.cancelledSiteIds.add(siteId)
      this.logProgress(active.id, {
        siteId,
        level: 'warn',
        message: '收到该站点终止请求，正在停止当前操作',
      })
      if (this.currentSiteId === siteId) {
        await this.newApi.cancelActiveTask().catch(() => undefined)
      }
      return this.db.getRun(active.id)
    }

    const stale = this.db.listRecentRuns(200)
      .find((run) => run.id === runId)
    const site = this.db.getSite(siteId)
    if (site?.lastStatus === 'running') this.db.recoverSiteRunning(siteId)
    if (stale?.status === 'running') {
      this.db.cancelRun(stale.id, {
        success: stale.successCount,
        failed: stale.failedCount,
        skipped: stale.skippedCount,
      })
      for (const candidate of this.db.listSites().filter((item) => item.lastStatus === 'running')) {
        this.db.recoverSiteRunning(candidate.id)
      }
    }
    return stale ?? this.db.getRun(runId)
  }

  private logProgress(
    runId: number,
    input: {
      message: string
      siteId?: number
      siteName?: string
      operation?: 'checkin' | 'balance_refresh'
      level?: 'info' | 'success' | 'warn' | 'error'
    },
  ) {
    this.progress?.add({ runId, ...input })
  }

  async run(
    trigger: RunTrigger,
    siteIds?: number[],
    retryAttempt = 0,
    options: { operation?: 'checkin' | 'balance_refresh' } = {},
  ): Promise<CheckinRun> {
    if (this.activeRun) throw new Error('已有签到任务正在运行')
    const explicitlySelectedByUser = trigger === 'manual' && Boolean(siteIds?.length)
    const candidates = this.db.listSites().filter((site) => {
      if (siteIds && !siteIds.includes(site.id)) return false
      if (options.operation === 'checkin' && site.checkinMode === 'balance_only') return false
      if (options.operation === 'balance_refresh' && site.checkinMode !== 'balance_only') return false
      if (explicitlySelectedByUser || site.enabled) return true
      return trigger === 'retry' && Boolean(siteIds?.length)
    })
    if (candidates.length === 0) throw new Error('没有可执行的站点')

    const run = this.db.startRun(trigger)
    this.activeRun = run
    this.cancelled = false
    this.cancelledSiteIds.clear()
    this.currentSiteId = null
    const runLabel = options.operation === 'balance_refresh' ? '余额刷新' : '签到'
    const failedSiteIds: number[] = []
    let success = 0
    let failed = 0
    let skipped = 0

    try {
      this.events.emit({ type: 'run_started', title: `${runLabel}任务已开始`, message: `正在处理 ${candidates.length} 个站点`, data: { runId: run.id } })
      this.logProgress(run.id, { message: `开始处理 ${candidates.length} 个站点` })
      for (const [siteIndex, site] of candidates.entries()) {
        if (this.cancelled) {
          skipped += candidates.length - siteIndex
          this.logProgress(run.id, {
            level: 'warn',
            message: '任务已取消，跳过后续站点',
          })
          break
        }
        this.currentSiteId = site.id
        try {
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止，跳过`,
            })
            continue
          }
          const balanceOnly = options.operation === 'balance_refresh'
            || site.checkinMode === 'balance_only'
            || (trigger !== 'manual' && !site.enabled)
          let operation: 'checkin' | 'balance_refresh' = balanceOnly ? 'balance_refresh' : 'checkin'
          this.logProgress(run.id, {
            siteId: site.id,
            siteName: site.name,
            operation,
            message: operation === 'checkin' ? `正在签到：${site.name}` : `正在刷新余额：${site.name}`,
          })
          let result: CheckinResult
          if (balanceOnly) {
            result = await this.newApi.refreshBalanceSite(site, run.id)
          } else {
            const checkinResult = await this.newApi.checkinSite(site, run.id)
            const shouldFallback = shouldRefreshBalanceAfterCheckin(checkinResult)
            if (checkinResult.status === 'disabled' || shouldFallback) {
              this.db.updateSiteCheckinMode(site.id, 'balance_only')
              operation = 'balance_refresh'
            }
            result = shouldFallback
              ? await this.newApi.refreshBalanceSite(site, run.id)
              : checkinResult
          }
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止`,
            })
            continue
          }
          const { id: _id, siteName: _siteName, ...storedResult } = result
          this.logProgress(run.id, {
            siteId: site.id,
            siteName: site.name,
            operation,
            level: result.status === 'failed' || result.status === 'manual_required' ? 'warn' : result.status === 'success' || result.status === 'already_checked' ? 'success' : 'info',
            message: `${site.name}：${result.message}`,
          })
          this.db.applyResult(site.id, storedResult, {
            preserveLastStatus: operation === 'balance_refresh'
              && result.status === 'disabled'
              && !['never', 'disabled'].includes(site.lastStatus),
          })
          await this.balanceSync?.syncSite(site.id).catch((error) => {
            this.events.emit({
              type: 'state_changed',
              title: '渠道余额同步失败',
              message: `${site.name}: ${error instanceof Error ? error.message : '未知错误'}`,
            })
          })

          if (['success', 'already_checked'].includes(result.status) || (operation === 'balance_refresh' && balanceRefreshSucceeded(result))) success += 1
          else if (result.status === 'disabled') skipped += 1
          else {
            failed += 1
            if (result.status === 'failed') failedSiteIds.push(site.id)
          }

          this.events.emit({
            type: 'site_result',
            title: resultTitle(result, operation),
            message: `${site.name}: ${result.message}`,
            data: { result, siteId: site.id, runId: run.id, operation },
          })
        } catch (error) {
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止`,
            })
            continue
          }
          throw error
        } finally {
          this.currentSiteId = null
        }
      }
    } finally {
      const cancelled = this.cancelled
      this.activeRun = null
      this.cancelled = false
      this.cancelledSiteIds.clear()
      this.currentSiteId = null
      const counts = { success, failed, skipped }
      const completed = (cancelled ? this.db.cancelRun(run.id, counts) : this.db.completeRun(run.id, counts))!
      this.events.emit({
        type: 'run_completed',
        title: cancelled ? `${runLabel}任务已取消` : completed.status === 'completed' ? `${runLabel}任务完成` : `${runLabel}任务已结束`,
        message: cancelled ? `任务已取消：成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}` : `成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}`,
        data: { run: completed },
      })
      this.logProgress(run.id, {
        level: cancelled || failed > 0 ? 'warn' : 'success',
        message: cancelled ? `任务已取消：成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}` : `任务结束：成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}`,
      })
      await this.telegram.notifyRun(completed, this.db.listResults({ runId: run.id, limit: 500 }))
        .catch((error) => {
          this.events.emit({
            type: 'state_changed',
            title: 'Telegram 通知失败',
            message: error instanceof Error ? error.message : '未知错误',
          })
        })
      if (!cancelled) this.scheduleRetries(failedSiteIds, retryAttempt)
    }
    return this.db.getRun(run.id)!
  }

  async refreshBalance(siteIds?: number[], options: CheckinBalanceSyncOptions = {}): Promise<CheckinRun> {
    if (this.activeRun) throw new Error('已有签到任务正在运行')
    const candidates = this.db.listSites().filter((site) => !siteIds || siteIds.includes(site.id))
    if (candidates.length === 0) throw new Error('没有可刷新的站点')

    const run = this.db.startRun('manual')
    this.activeRun = run
    this.cancelled = false
    this.cancelledSiteIds.clear()
    this.currentSiteId = null
    this.events.emit({
      type: 'run_started',
      title: '余额刷新已开始',
      message: `正在刷新 ${candidates.length} 个站点的余额`,
      data: { runId: run.id, operation: 'balance_refresh' },
    })
    this.logProgress(run.id, { message: `开始刷新 ${candidates.length} 个站点的余额` })

    let success = 0
    let failed = 0
    let skipped = 0
    try {
      for (const [siteIndex, site] of candidates.entries()) {
        if (this.cancelled) {
          skipped += candidates.length - siteIndex
          this.logProgress(run.id, {
            level: 'warn',
            message: '任务已取消，跳过后续站点',
          })
          break
        }
        this.currentSiteId = site.id
        try {
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止，跳过`,
            })
            continue
          }
          this.logProgress(run.id, {
            siteId: site.id,
            siteName: site.name,
            operation: 'balance_refresh',
            message: `正在刷新余额：${site.name}`,
          })
          let result: CheckinResult
          try {
            result = await this.newApi.refreshBalanceSite(site, run.id)
          } catch (error) {
            if (this.cancelledSiteIds.has(site.id)) {
              skipped += 1
              this.db.recoverSiteRunning(site.id)
              this.logProgress(run.id, {
                siteId: site.id,
                siteName: site.name,
                level: 'warn',
                message: `${site.name}：该站点已终止`,
              })
              continue
            }
            result = balanceRefreshFailure(site, run.id, error)
          }
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止`,
            })
            continue
          }
          const { id: _id, siteName: _siteName, ...storedResult } = result
          this.logProgress(run.id, {
            siteId: site.id,
            siteName: site.name,
            operation: 'balance_refresh',
            level: balanceRefreshSucceeded(result) ? 'success' : result.status === 'manual_required' ? 'warn' : result.status === 'failed' ? 'error' : 'info',
            message: `${site.name}：${result.message}`,
          })
          this.db.applyResult(site.id, storedResult, {
            preserveLastStatus: result.status === 'disabled' && !['never', 'disabled'].includes(site.lastStatus),
          })
          await this.balanceSync?.syncSite(site.id, options).catch((error) => {
            this.events.emit({
              type: 'state_changed',
              title: '渠道余额同步失败',
              message: `${site.name}: ${error instanceof Error ? error.message : '未知错误'}`,
            })
          })

          if (balanceRefreshSucceeded(result)) success += 1
          else if (result.status === 'failed' || result.status === 'manual_required') failed += 1
          else skipped += 1

          this.events.emit({
            type: 'site_result',
            title: balanceRefreshSucceeded(result) ? '余额刷新成功' : result.status === 'manual_required' ? '余额刷新需要授权' : '余额刷新未完成',
            message: `${site.name}: ${result.message}`,
            data: { result, siteId: site.id, runId: run.id, operation: 'balance_refresh' },
          })
        } catch (error) {
          if (this.cancelledSiteIds.has(site.id)) {
            skipped += 1
            this.db.recoverSiteRunning(site.id)
            this.logProgress(run.id, {
              siteId: site.id,
              siteName: site.name,
              level: 'warn',
              message: `${site.name}：该站点已终止`,
            })
            continue
          }
          throw error
        } finally {
          this.currentSiteId = null
        }
      }
    } finally {
      const cancelled = this.cancelled
      this.activeRun = null
      this.cancelled = false
      this.cancelledSiteIds.clear()
      this.currentSiteId = null
      const counts = { success, failed, skipped }
      const completed = (cancelled ? this.db.cancelRun(run.id, counts) : this.db.completeRun(run.id, counts))!
      this.events.emit({
        type: 'run_completed',
        title: cancelled ? '余额刷新已取消' : '余额刷新已完成',
        message: cancelled ? `任务已取消：成功 ${success}，失败或需授权 ${failed}，跳过 ${skipped}` : `成功 ${success}，失败或需授权 ${failed}，跳过 ${skipped}`,
        data: { run: completed, operation: 'balance_refresh' },
      })
      this.logProgress(run.id, {
        level: cancelled || failed > 0 ? 'warn' : 'success',
        message: cancelled ? `余额刷新已取消：成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}` : `余额刷新结束：成功 ${success}，失败或需处理 ${failed}，跳过 ${skipped}`,
      })
    }
    return this.db.getRun(run.id)!
  }

  /** Records a result performed by the narrowly scoped local browser assistant. */
  async recordLocalExecution(
    siteId: number,
    operation: LocalExecutionOperation,
    report: Pick<LocalExecutionReport, 'status' | 'message' | 'balanceRaw' | 'rewardRaw'>,
  ): Promise<CheckinResult> {
    if (this.activeRun) throw new Error('已有签到任务正在运行')
    const site = this.db.getSite(siteId)
    if (!site) throw new Error('站点不存在')

    const run = this.db.startRun('manual')
    this.activeRun = run
    this.cancelled = false
    this.cancelledSiteIds.clear()
    this.currentSiteId = null
    this.events.emit({
      type: 'run_started',
      title: operation === 'checkin' ? '本地签到已开始' : '本地余额刷新已开始',
      message: `${site.name}: 正在接收本地授权助手执行结果`,
      data: { runId: run.id, siteId, operation, localExecution: true },
    })
    this.logProgress(run.id, {
      siteId,
      siteName: site.name,
      operation,
      message: operation === 'checkin' ? `正在本地执行签到：${site.name}` : `正在本地刷新余额：${site.name}`,
    })

    let success = 0
    let failed = 0
    let storedResult: CheckinResult | null = null
    try {
      const completedAt = new Date().toISOString()
      const balanceAfterAmount = quotaToAmount(report.balanceRaw, site.quotaPerUnit, site.displayScale)
      const rewardAmount = quotaToAmount(report.rewardRaw, site.quotaPerUnit, site.displayScale)
      const balanceDeltaAmount = site.lastBalanceAmount !== null && balanceAfterAmount !== null
        ? roundAmount(balanceAfterAmount - site.lastBalanceAmount)
        : null
      const result: Omit<CheckinResult, 'id' | 'siteName'> = {
        runId: run.id,
        siteId,
        status: report.status,
        rewardRaw: report.rewardRaw,
        rewardAmount,
        balanceBeforeRaw: site.lastBalanceRaw,
        balanceBeforeAmount: site.lastBalanceAmount,
        balanceAfterRaw: report.balanceRaw,
        balanceAfterAmount,
        balanceDeltaAmount,
        message: report.message,
        startedAt: run.startedAt,
        completedAt,
        loginVerified: localExecutionLoginVerified(report.status, report.message),
      }
      this.db.applyResult(siteId, result)
      storedResult = this.db.listResults({ runId: run.id, limit: 1 })[0] ?? null

      await this.balanceSync?.syncSite(siteId).catch((error) => {
        this.events.emit({
          type: 'state_changed',
          title: '渠道余额同步失败',
          message: `${site.name}: ${error instanceof Error ? error.message : '未知错误'}`,
        })
      })

      if (report.status === 'success' || report.status === 'already_checked') success = 1
      else failed = 1
      this.events.emit({
        type: 'site_result',
        title: resultTitle({ ...result, id: storedResult?.id ?? 0, siteName: site.name }, operation),
        message: `${site.name}: ${report.message}`,
        data: { result: storedResult ?? { ...result, id: 0, siteName: site.name }, siteId, runId: run.id, operation, localExecution: true },
      })
    } finally {
      const completed = this.db.completeRun(run.id, { success, failed, skipped: 0 })!
      this.activeRun = null
      this.events.emit({
        type: 'run_completed',
        title: completed.status === 'completed' ? '本地执行已完成' : '本地执行已结束',
        message: `成功 ${success}，失败或需处理 ${failed}`,
        data: { run: completed, operation, localExecution: true },
      })
      this.logProgress(run.id, {
        level: failed > 0 ? 'warn' : 'success',
        message: `本地执行结束：成功 ${success}，失败或需处理 ${failed}`,
      })
      await this.telegram.notifyRun(completed, this.db.listResults({ runId: run.id, limit: 500 }))
        .catch((error) => {
          this.events.emit({
            type: 'state_changed',
            title: 'Telegram 通知失败',
            message: error instanceof Error ? error.message : '未知错误',
          })
        })
    }

    if (!storedResult) throw new Error('本地执行结果未保存')
    return storedResult
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

function balanceRefreshSucceeded(result: CheckinResult): boolean {
  return result.balanceAfterAmount !== null && /余额已刷新|余额刷新成功|balance.*refresh/i.test(result.message)
}

function balanceRefreshFailure(site: { id: number; name: string; lastBalanceRaw: number | null; lastBalanceAmount: number | null }, runId: number, error: unknown): CheckinResult {
  const now = new Date().toISOString()
  return {
    id: 0,
    runId,
    siteId: site.id,
    siteName: site.name,
    status: 'failed',
    rewardRaw: null,
    rewardAmount: null,
    balanceBeforeRaw: site.lastBalanceRaw,
    balanceBeforeAmount: site.lastBalanceAmount,
    balanceAfterRaw: null,
    balanceAfterAmount: null,
    balanceDeltaAmount: null,
    message: error instanceof Error ? error.message : '余额刷新失败',
    startedAt: now,
    completedAt: now,
  }
}

function resultTitle(result: CheckinResult, operation: 'checkin' | 'balance_refresh'): string {
  if (operation === 'balance_refresh') {
    if (balanceRefreshSucceeded(result)) return '余额刷新成功'
    if (result.status === 'manual_required') return '余额刷新需要授权'
    if (result.status === 'failed') return '余额刷新失败'
    return '余额刷新未完成'
  }
  if (result.status === 'success') return '签到成功'
  if (result.status === 'already_checked') return '今日已签到'
  if (result.status === 'manual_required') return '需要人工处理'
  if (result.status === 'disabled') return '站点未开放签到'
  return '签到失败'
}

function shouldRefreshBalanceAfterCheckin(result: CheckinResult): boolean {
  if (result.status === 'disabled') return !balanceRefreshSucceeded(result)
  if (result.status !== 'failed') return false
  return /^(?:not found|method not allowed|未找到|不存在)$/i.test(result.message.trim())
    || /(?:签到|check[-_ ]?in).*(?:404|不存在|未启用|不支持|未开放|不可用)/i.test(result.message)
}

function localExecutionLoginVerified(status: LocalExecutionReport['status'], message: string): boolean {
  if (status === 'success' || status === 'already_checked') return true
  return !/(?:登录|未登录|login|unauthorized|401|会话.*失效|token.*(?:失效|invalid|expired))/i.test(message)
}
