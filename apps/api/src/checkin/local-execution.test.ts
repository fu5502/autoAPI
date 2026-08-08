import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { LocalExecutionError, LocalExecutionService } from './local-execution.js'
import type { CheckinResult } from './types.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createService() {
  const database = new AppDatabase(':memory:')
  databases.push(database)
  const persist = vi.fn(async ({ siteId, operation, report }) => ({
    id: 1,
    runId: 1,
    siteId,
    siteName: '黑与白福利站',
    status: report.status,
    rewardRaw: report.rewardRaw,
    rewardAmount: report.rewardRaw === null ? null : report.rewardRaw / 500_000,
    balanceBeforeRaw: null,
    balanceBeforeAmount: null,
    balanceAfterRaw: report.balanceRaw,
    balanceAfterAmount: report.balanceRaw === null ? null : report.balanceRaw / 500_000,
    balanceDeltaAmount: null,
    message: `${operation}: ${report.message}`,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  } satisfies CheckinResult))
  return {
    database,
    persist,
    service: new LocalExecutionService(database, new EventBus(), persist),
  }
}

describe('hybgzs local execution service', () => {
  it('claims a fixed-domain task and accepts one authenticated report only', async () => {
    const { database, persist, service } = createService()
    const site = database.createSite('黑与白福利站', 'https://cdk.hybgzs.com')
    const task = service.create(site, 'checkin')

    expect(task).toMatchObject({
      siteUrl: 'https://cdk.hybgzs.com',
      domain: 'cdk.hybgzs.com',
      operation: 'checkin',
    })
    expect(Date.parse(task.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)

    expect(() => service.claim(task.code, 'www.cdk.hybgzs.com')).toThrow(LocalExecutionError)
    const claim = service.claim(task.code, 'cdk.hybgzs.com')
    expect(claim).toMatchObject({
      executionId: task.executionId,
      siteName: site.name,
      siteUrl: site.baseUrl,
      domain: 'cdk.hybgzs.com',
      operation: 'checkin',
    })

    await expect(service.report({
      executionId: task.executionId,
      resultToken: 'incorrect-token',
      report: {
        executionId: task.executionId,
        status: 'success',
        message: '签到成功',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })).rejects.toMatchObject({ type: 'local_execution_token_invalid' })

    const status = await service.report({
      executionId: task.executionId,
      resultToken: claim.resultToken,
      report: {
        executionId: task.executionId,
        status: 'success',
        message: '签到成功',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })

    expect(persist).toHaveBeenCalledWith({
      siteId: site.id,
      operation: 'checkin',
      report: expect.objectContaining({ status: 'success', balanceRaw: 1_500_000, rewardRaw: 500_000 }),
    })
    expect(status).toMatchObject({ status: 'success', result: { balanceAfterAmount: 3, rewardAmount: 1 } })
    await expect(service.report({
      executionId: task.executionId,
      resultToken: claim.resultToken,
      report: {
        executionId: task.executionId,
        status: 'success',
        message: '重复上报',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })).rejects.toMatchObject({ type: 'local_execution_finished' })
  })

  it('rejects unsupported sites and balance reports that attempt to write a reward', async () => {
    const { database, service } = createService()
    const unsupported = database.createSite('其他站点', 'https://other.example')
    let unsupportedError: unknown
    try {
      service.create(unsupported, 'checkin')
    } catch (error) {
      unsupportedError = error
    }
    expect(unsupportedError).toMatchObject({
      type: 'local_execution_unsupported_site',
      statusCode: 422,
    })
    const insecureTarget = database.createSite('不安全黑与白站点', 'http://cdk.hybgzs.com')
    expect(() => service.create(insecureTarget, 'checkin')).toThrow(LocalExecutionError)

    const site = database.createSite('黑与白福利站', 'https://cdk.hybgzs.com')
    const task = service.create(site, 'balance_refresh')
    const claim = service.claim(task.code, 'cdk.hybgzs.com')
    await expect(service.report({
      executionId: task.executionId,
      resultToken: claim.resultToken,
      report: {
        executionId: task.executionId,
        status: 'success',
        message: '余额已刷新',
        balanceRaw: 500_000,
        rewardRaw: 1,
      },
    })).rejects.toMatchObject({ type: 'local_execution_result_invalid' })
  })

  it('cancels the task when its site is changed before the report arrives', async () => {
    const { database, service } = createService()
    const site = database.createSite('黑与白福利站', 'https://cdk.hybgzs.com')
    const task = service.create(site, 'balance_refresh')
    const claim = service.claim(task.code, 'cdk.hybgzs.com')
    database.updateSite(site.id, { baseUrl: 'https://other.example' })

    await expect(service.report({
      executionId: task.executionId,
      resultToken: claim.resultToken,
      report: {
        executionId: task.executionId,
        status: 'success',
        message: '余额已刷新',
        balanceRaw: 500_000,
        rewardRaw: null,
      },
    })).rejects.toMatchObject({ type: 'local_execution_site_changed' })
    expect(service.getStatus(task.executionId, site.id)).toMatchObject({ status: 'cancelled' })
  })
})
