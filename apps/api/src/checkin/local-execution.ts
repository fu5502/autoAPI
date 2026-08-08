import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AppDatabase } from './db.js'
import type { EventBus } from './events.js'
import type { CheckinResult, Site } from './types.js'

const LOCAL_EXECUTION_DOMAIN = 'cdk.hybgzs.com'
const LOCAL_EXECUTION_TTL_MS = 10 * 60_000

export type LocalExecutionOperation = 'balance_refresh' | 'checkin'
export type LocalExecutionOutcomeStatus = 'success' | 'already_checked' | 'manual_required' | 'failed'
export type LocalExecutionTaskStatus = 'waiting' | 'claimed' | 'reporting' | LocalExecutionOutcomeStatus | 'expired' | 'cancelled'

export interface LocalExecutionInfo {
  executionId: string
  code: string
  siteUrl: string
  domain: typeof LOCAL_EXECUTION_DOMAIN
  operation: LocalExecutionOperation
  expiresAt: string
}

export interface LocalExecutionClaim {
  executionId: string
  siteName: string
  siteUrl: string
  domain: typeof LOCAL_EXECUTION_DOMAIN
  operation: LocalExecutionOperation
  resultToken: string
  expiresAt: string
}

export interface LocalExecutionReport {
  executionId: string
  status: LocalExecutionOutcomeStatus
  message: string
  balanceRaw: number | null
  rewardRaw: number | null
}

export interface LocalExecutionStatus {
  executionId: string
  siteId: number
  siteName: string
  siteUrl: string
  domain: typeof LOCAL_EXECUTION_DOMAIN
  operation: LocalExecutionOperation
  status: LocalExecutionTaskStatus
  expiresAt: string
  claimedAt: string | null
  completedAt: string | null
  message: string
  result: CheckinResult | null
}

export interface LocalExecutionPersistInput {
  siteId: number
  operation: LocalExecutionOperation
  report: LocalExecutionReport
}

interface LocalExecutionTask extends LocalExecutionInfo {
  siteId: number
  siteName: string
  resultToken: string
  status: LocalExecutionTaskStatus
  claimedAt: string | null
  completedAt: string | null
  message: string
  result: CheckinResult | null
}

export class LocalExecutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly type: string,
  ) {
    super(message)
    this.name = 'LocalExecutionError'
  }
}

/**
 * Runs one narrowly-defined action in the user's local browser when the
 * server-side browser is blocked by cdk.hybgzs.com's verification page.
 * Tasks are intentionally memory-only and cannot target arbitrary URLs.
 */
export class LocalExecutionService {
  private readonly tasks = new Map<string, LocalExecutionTask>()

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBus,
    private readonly persist: (input: LocalExecutionPersistInput) => Promise<CheckinResult>,
  ) {}

  create(site: Site, operation: LocalExecutionOperation): LocalExecutionInfo {
    this.cleanup()
    assertSupportedSite(site)
    this.cancelForSite(site.id, '已生成新的本地执行任务')

    const executionId = randomUUID()
    const expiresAt = new Date(Date.now() + LOCAL_EXECUTION_TTL_MS).toISOString()
    const task: LocalExecutionTask = {
      executionId,
      code: createCode(),
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.baseUrl,
      domain: LOCAL_EXECUTION_DOMAIN,
      operation,
      resultToken: randomBytes(32).toString('base64url'),
      expiresAt,
      status: 'waiting',
      claimedAt: null,
      completedAt: null,
      message: '等待本地授权助手执行',
      result: null,
    }
    this.tasks.set(executionId, task)
    this.events.emit({
      type: 'state_changed',
      title: '本地执行任务已创建',
      message: `${site.name}: 等待本地授权助手执行`,
      data: { siteId: site.id, executionId, operation },
    })
    return this.toInfo(task)
  }

  getStatus(executionId: string, siteId: number): LocalExecutionStatus | null {
    this.cleanup()
    const task = this.tasks.get(executionId)
    if (!task || task.siteId !== siteId) return null
    return this.toStatus(task)
  }

  cancel(executionId: string, siteId: number): LocalExecutionStatus | null {
    this.cleanup()
    const task = this.tasks.get(executionId)
    if (!task || task.siteId !== siteId) return null
    if (task.status === 'waiting' || task.status === 'claimed') {
      task.status = 'cancelled'
      task.message = '本次本地执行已取消'
      this.clearSecrets(task)
    }
    return this.toStatus(task)
  }

  cancelForSite(siteId: number, message = '关联站点已删除，本地执行任务已取消'): void {
    for (const task of this.tasks.values()) {
      if (task.siteId !== siteId || (task.status !== 'waiting' && task.status !== 'claimed')) continue
      task.status = 'cancelled'
      task.message = message
      this.clearSecrets(task)
    }
  }

  claim(code: string, hostname: string): LocalExecutionClaim {
    this.cleanup()
    const task = [...this.tasks.values()].find((item) => item.code === code.trim().toUpperCase())
    if (!task) throw new LocalExecutionError('本地执行码不存在或已过期', 401, 'local_execution_code_invalid')
    if (task.status !== 'waiting') throw new LocalExecutionError('本地执行任务已结束，请在后台重新生成', 409, 'local_execution_finished')
    if (hostname.trim().toLowerCase() !== LOCAL_EXECUTION_DOMAIN) {
      throw new LocalExecutionError(`当前站点 ${hostname} 与目标站点 ${LOCAL_EXECUTION_DOMAIN} 不匹配`, 401, 'local_execution_domain_mismatch')
    }

    task.status = 'claimed'
    task.claimedAt = nowIso()
    task.message = '本地授权助手已连接，正在执行站点操作'
    return {
      executionId: task.executionId,
      siteName: task.siteName,
      siteUrl: task.siteUrl,
      domain: task.domain,
      operation: task.operation,
      resultToken: task.resultToken,
      expiresAt: task.expiresAt,
    }
  }

  async report(input: { executionId: string; resultToken: string; report: LocalExecutionReport }): Promise<LocalExecutionStatus> {
    this.cleanup()
    const task = this.tasks.get(input.executionId)
    if (!task) throw new LocalExecutionError('本地执行任务不存在或已过期', 401, 'local_execution_not_found')
    if (task.status !== 'claimed') throw new LocalExecutionError('本地执行任务已结束或尚未连接，请重新生成', 409, 'local_execution_finished')
    if (input.report.executionId !== task.executionId) {
      throw new LocalExecutionError('本地执行任务标识不匹配', 400, 'local_execution_mismatch')
    }
    if (!secureEqual(task.resultToken, input.resultToken)) {
      throw new LocalExecutionError('本地执行结果 Token 不正确', 401, 'local_execution_token_invalid')
    }
    validateReportForOperation(task.operation, input.report)
    this.assertUnchangedSite(task)

    task.status = 'reporting'
    try {
      const result = await this.persist({
        siteId: task.siteId,
        operation: task.operation,
        report: input.report,
      })
      task.status = input.report.status
      task.completedAt = nowIso()
      task.message = input.report.message
      task.result = result
      this.clearSecrets(task)
      this.events.emit({
        type: 'state_changed',
        title: task.operation === 'checkin' ? '本地签到结果已接收' : '本地余额刷新结果已接收',
        message: `${task.siteName}: ${task.message}`,
        data: { siteId: task.siteId, executionId: task.executionId, operation: task.operation, result },
      })
      return this.toStatus(task)
    } catch (error) {
      // A conflict (for example a concurrently running scheduled task) must
      // not consume an otherwise valid local-browser result.
      if (task.status === 'reporting') task.status = 'claimed'
      throw error
    }
  }

  close(): void {
    for (const task of this.tasks.values()) this.clearSecrets(task)
    this.tasks.clear()
  }

  private assertUnchangedSite(task: LocalExecutionTask): void {
    const site = this.db.getSite(task.siteId)
    if (!site || site.baseUrl !== task.siteUrl || !isSupportedSite(site)) {
      task.status = 'cancelled'
      task.message = '目标站点已变更，本地执行任务已取消'
      this.clearSecrets(task)
      throw new LocalExecutionError(task.message, 409, 'local_execution_site_changed')
    }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [executionId, task] of this.tasks) {
      if (Date.parse(task.expiresAt) <= now && (task.status === 'waiting' || task.status === 'claimed')) {
        task.status = 'expired'
        task.message = '本地执行码已过期，请重新生成'
        this.clearSecrets(task)
      }
      if (task.status !== 'waiting' && task.status !== 'claimed' && task.status !== 'reporting'
        && Date.parse(task.expiresAt) + LOCAL_EXECUTION_TTL_MS <= now) {
        this.tasks.delete(executionId)
      }
    }
  }

  private toInfo(task: LocalExecutionTask): LocalExecutionInfo {
    return {
      executionId: task.executionId,
      code: task.code,
      siteUrl: task.siteUrl,
      domain: task.domain,
      operation: task.operation,
      expiresAt: task.expiresAt,
    }
  }

  private toStatus(task: LocalExecutionTask): LocalExecutionStatus {
    return {
      executionId: task.executionId,
      siteId: task.siteId,
      siteName: task.siteName,
      siteUrl: task.siteUrl,
      domain: task.domain,
      operation: task.operation,
      status: task.status,
      expiresAt: task.expiresAt,
      claimedAt: task.claimedAt,
      completedAt: task.completedAt,
      message: task.message,
      result: task.result,
    }
  }

  private clearSecrets(task: LocalExecutionTask): void {
    task.code = ''
    task.resultToken = ''
  }
}

function assertSupportedSite(site: Site): void {
  if (!isSupportedSite(site)) {
    throw new LocalExecutionError(`仅支持 ${LOCAL_EXECUTION_DOMAIN} 的本地执行`, 422, 'local_execution_unsupported_site')
  }
}

function isSupportedSite(site: Pick<Site, 'baseUrl'>): boolean {
  try {
    const url = new URL(site.baseUrl)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.hostname.toLowerCase() === LOCAL_EXECUTION_DOMAIN
  } catch {
    return false
  }
}

function validateReportForOperation(operation: LocalExecutionOperation, report: LocalExecutionReport): void {
  if (operation === 'balance_refresh' && report.rewardRaw !== null) {
    throw new LocalExecutionError('余额刷新结果不能包含签到奖励', 400, 'local_execution_result_invalid')
  }
  if (!['success', 'already_checked'].includes(report.status) && report.rewardRaw !== null) {
    throw new LocalExecutionError('未完成签到不能包含签到奖励', 400, 'local_execution_result_invalid')
  }
  if (operation === 'balance_refresh' && report.status === 'success' && report.balanceRaw === null) {
    throw new LocalExecutionError('余额刷新成功时必须提供余额', 400, 'local_execution_result_invalid')
  }
}

function createCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(12)
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('')
}

function nowIso(): string {
  return new Date().toISOString()
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
