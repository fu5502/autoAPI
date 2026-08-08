import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from './browser-manager.js'
import { CheckinCoordinator } from './coordinator.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { NewApiService } from './new-api.js'
import { TelegramNotifier } from './telegram.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('automated browser task lifecycle', () => {
  it('serializes overlapping BrowserManager runs', async () => {
    const manager = new BrowserManager()
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const fakePage = {
      url: () => 'https://example.com',
      isClosed: () => false,
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const fakeContext = { pages: () => [], newPage: vi.fn(async () => fakePage) }
    vi.spyOn(manager as unknown as { ensureContext: () => Promise<unknown> }, 'ensureContext').mockResolvedValue(fakeContext)
    vi.spyOn(manager as unknown as { shutdown: () => Promise<void> }, 'shutdown').mockImplementation(async () => {
      calls.push('shutdown')
    })

    const first = manager.run({ interactive: false, closeBrowserWhenDone: true }, async () => {
      calls.push('first-start')
      await firstBlocked
      calls.push('first-end')
      return 'first'
    })
    await Promise.resolve()
    const second = manager.run({ interactive: false, closeBrowserWhenDone: true }, async () => {
      calls.push('second-start')
      return 'second'
    })

    await vi.waitFor(() => expect(calls).toEqual(['first-start']))
    releaseFirst()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(calls).toEqual(['first-start', 'first-end', 'shutdown', 'second-start', 'shutdown'])
  })

  it('closes Chromium after each automated check-in and balance refresh', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Example', 'https://example.com')
    const options: Array<{ interactive: boolean; closeBrowserWhenDone?: boolean; timeoutMs?: number }> = []
    const browser = {
      run: vi.fn(async (runOptions: { interactive: boolean; closeBrowserWhenDone?: boolean; timeoutMs?: number }, _task: unknown) => {
        options.push(runOptions)
        throw new Error('test stop before browser task')
      }),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    await service.checkinSite(site, database.startRun('manual').id)
    await service.refreshBalanceSite(site, database.startRun('manual').id)

    expect(options).toEqual([
      { interactive: false, closeBrowserWhenDone: true, timeoutMs: 15_000 },
      { interactive: false, closeBrowserWhenDone: true, timeoutMs: 15_000 },
    ])
  })
})

describe('coordinator browser work', () => {
  it('keeps site work one-at-a-time even when callers overlap', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const firstSite = database.createSite('First', 'https://first.example')
    const secondSite = database.createSite('Second', 'https://second.example')
    let active = 0
    let maxActive = 0
    const checkinSite = vi.fn(async (site: { id: number }, runId: number) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return {
        id: 0,
        runId,
        siteId: site.id,
        siteName: 'site',
        status: 'success' as const,
        rewardRaw: null,
        rewardAmount: null,
        balanceBeforeRaw: null,
        balanceBeforeAmount: null,
        balanceAfterRaw: null,
        balanceAfterAmount: null,
        balanceDeltaAmount: null,
        message: 'ok',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }
    })
    const newApi = { checkinSite, refreshBalanceSite: vi.fn() } as unknown as NewApiService
    const coordinator = new CheckinCoordinator(database, newApi, new EventBus(), new TelegramNotifier(database))

    const first = coordinator.run('manual', [firstSite.id])
    await Promise.resolve()
    await expect(coordinator.run('manual', [secondSite.id])).rejects.toThrow('已有签到任务正在运行')
    await first

    expect(maxActive).toBe(1)
  })
})
