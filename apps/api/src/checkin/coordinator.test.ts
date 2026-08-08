import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckinCoordinator } from './coordinator.js'
import { CheckinBalanceSync } from './channel-balance.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { NewApiService } from './new-api.js'
import { TelegramNotifier } from './telegram.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function result(siteId: number, runId: number, status: 'failed' | 'disabled', message: string, afterRaw: number | null = null) {
  return {
    id: 0,
    runId,
    siteId,
    siteName: 'Aixoras',
    status,
    rewardRaw: null,
    rewardAmount: null,
    balanceBeforeRaw: null,
    balanceBeforeAmount: null,
    balanceAfterRaw: afterRaw,
    balanceAfterAmount: afterRaw,
    balanceDeltaAmount: null,
    message,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  } as const
}

describe('CheckinCoordinator manual balance fallback', () => {
  it('does not leave an active run when no sites are executable', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const coordinator = new CheckinCoordinator(database, {} as NewApiService, new EventBus(), new TelegramNotifier(database))

    await expect(coordinator.run('manual', [999])).rejects.toThrow('没有可执行的站点')

    expect(coordinator.getActiveRun()).toBeNull()
    expect(database.listRecentRuns(10)).toEqual([])
  })

  it('skips disabled sites during scheduled runs', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    database.createSite('已关闭站点', 'https://disabled.example')
    database.updateSite(1, { enabled: false })
    const coordinator = new CheckinCoordinator(database, {} as NewApiService, new EventBus(), new TelegramNotifier(database))

    await expect(coordinator.run('scheduled')).rejects.toThrow('没有可执行的站点')

    expect(coordinator.getActiveRun()).toBeNull()
    expect(database.listRecentRuns(10)).toEqual([])
  })

  it('refreshes balance when a manual check-in endpoint is missing', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Aixoras', 'https://aixoras.com')
    const checkinSite = vi.fn(async (_site: unknown, runId: number) => result(site.id, runId, 'failed', 'Not Found'))
    const refreshBalanceSite = vi.fn(async (_site: unknown, runId: number) => result(site.id, runId, 'disabled', '页面不支持签到，余额已刷新', 42))
    const newApi = { checkinSite, refreshBalanceSite } as unknown as NewApiService
    const coordinator = new CheckinCoordinator(database, newApi, new EventBus(), new TelegramNotifier(database))

    await coordinator.run('manual', [site.id])

    expect(checkinSite).toHaveBeenCalledOnce()
    expect(refreshBalanceSite).toHaveBeenCalledOnce()
    expect(database.listResults({ siteId: site.id, limit: 1 })[0]).toMatchObject({
      status: 'disabled',
      message: '页面不支持签到，余额已刷新',
      balanceAfterRaw: 42,
    })
    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'balance_only' })

    await coordinator.run('manual', [site.id])

    expect(checkinSite).toHaveBeenCalledOnce()
    expect(refreshBalanceSite).toHaveBeenCalledTimes(2)
  })

  it('does not perform a second browser run for ordinary upstream failures', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('普通站点', 'https://example.com')
    const checkinSite = vi.fn(async () => result(site.id, 1, 'failed', '上游请求超时'))
    const refreshBalanceSite = vi.fn(async () => result(site.id, 1, 'disabled', '余额已刷新', 1))
    const newApi = { checkinSite, refreshBalanceSite } as unknown as NewApiService
    const coordinator = new CheckinCoordinator(database, newApi, new EventBus(), new TelegramNotifier(database))

    await coordinator.run('manual', [site.id])

    expect(refreshBalanceSite).not.toHaveBeenCalled()
    expect(database.listResults({ siteId: site.id, limit: 1 })[0]).toMatchObject({ status: 'failed', message: '上游请求超时' })
  })

  it('does not refresh twice when the check-in adapter already returned a refreshed balance', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('YiAPI', 'https://yiapi.ai')
    const checkinSite = vi.fn(async (_site: unknown, runId: number) => result(site.id, runId, 'disabled', 'YiAPI 未提供签到接口，余额已刷新', 42))
    const refreshBalanceSite = vi.fn()
    const newApi = { checkinSite, refreshBalanceSite } as unknown as NewApiService
    const coordinator = new CheckinCoordinator(database, newApi, new EventBus(), new TelegramNotifier(database))

    const run = await coordinator.run('manual', [site.id])

    expect(run).toMatchObject({ status: 'completed', successCount: 1, skippedCount: 0 })
    expect(checkinSite).toHaveBeenCalledOnce()
    expect(refreshBalanceSite).not.toHaveBeenCalled()
    expect(database.getSite(site.id)).toMatchObject({ checkinMode: 'balance_only', lastBalanceAmount: 42 })
  })

  it('refreshes balance without invoking the check-in endpoint', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Balance site', 'https://balance.example')
    const checkinSite = vi.fn()
    const refreshBalanceSite = vi.fn(async () => result(site.id, 1, 'disabled', 'balance refreshed', 42))
    const newApi = { checkinSite, refreshBalanceSite } as unknown as NewApiService
    const coordinator = new CheckinCoordinator(database, newApi, new EventBus(), new TelegramNotifier(database))

    const run = await coordinator.refreshBalance([site.id])

    expect(run.status).toBe('completed')
    expect(checkinSite).not.toHaveBeenCalled()
    expect(refreshBalanceSite).toHaveBeenCalledOnce()
    expect(database.getSite(site.id)).toMatchObject({ lastBalanceAmount: 42, lastStatus: 'disabled' })
  })
})

describe('CheckinCoordinator local assistant results', () => {
  it('persists server-derived amounts and synchronizes the linked channel balance', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白福利站', 'https://cdk.hybgzs.com')
    database.updateSiteAuth(site.id, {
      adapter: 'hybgzs-welfare',
      authStatus: 'valid',
      quotaPerUnit: 500_000,
      displayScale: 1,
      lastBalanceRaw: 1_000_000,
      lastBalanceAmount: 2,
    })
    const balanceSync = { syncSite: vi.fn(async () => ({ updatedChannelIds: [], skippedBecauseBalanceIsUnknown: false })) } as unknown as CheckinBalanceSync
    const coordinator = new CheckinCoordinator(
      database,
      {} as NewApiService,
      new EventBus(),
      new TelegramNotifier(database),
      balanceSync,
    )

    const result = await coordinator.recordLocalExecution(site.id, 'checkin', {
      status: 'success',
      message: '本地签到成功',
      balanceRaw: 1_750_000,
      rewardRaw: 500_000,
    })

    expect(result).toMatchObject({
      status: 'success',
      balanceBeforeRaw: 1_000_000,
      balanceBeforeAmount: 2,
      balanceAfterRaw: 1_750_000,
      balanceAfterAmount: 3.5,
      balanceDeltaAmount: 1.5,
      rewardRaw: 500_000,
      rewardAmount: 1,
    })
    expect(database.getSite(site.id)).toMatchObject({
      authStatus: 'valid',
      lastBalanceRaw: 1_750_000,
      lastBalanceAmount: 3.5,
      lastRewardAmount: 1,
    })
    expect(balanceSync.syncSite).toHaveBeenCalledWith(site.id)
    expect(database.getRun(result.runId)).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 })
  })
})
