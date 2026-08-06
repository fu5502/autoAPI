import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserManager } from './browser-manager.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { NewApiService } from './new-api.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('NewApiService CHY authorization', () => {
  it('retries page reads when CHY navigation destroys the execution context', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('CHY 流量签到', 'https://dy.chybenzun.top')
    let evaluateCount = 0

    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      isClosed: () => false,
      url: () => site.baseUrl,
      evaluate: async (callback: unknown) => {
        evaluateCount += 1
        if (evaluateCount === 1) {
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
        }
        if (String(callback).includes('.stat') && String(callback).includes('alreadyClaimed')) {
          return {
            authenticated: true,
            title: 'CHY 公益订阅',
            username: 'test-user',
            stats: { total: 40, used: 0, remaining: 40 },
            claim: { href: '/claim', text: '领取今日 5GB' },
            alreadyClaimed: false,
          }
        }
        return null
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const state = service.startAuthorization(site.id)
    for (let attempt = 0; attempt < 20 && state.status === 'waiting'; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    expect(state.status).toBe('success')
    expect(evaluateCount).toBe(2)
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'chy-traffic',
      authStatus: 'valid',
      username: 'test-user',
    })
  })
})

describe('NewApiService channel import', () => {
  it('reads a complete New API key from the batch key endpoint when the list is masked', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('New API 测试站', 'https://new-api.example')
    database.updateSiteAuth(site.id, { adapter: 'new-api-modern', authStatus: 'valid' })

    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async (_callback: unknown, input: { pathname?: string }) => {
        if (input.pathname === '/api/user/auth/refresh') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { access_token: 'dashboard-session-token' } }
        }
        if (input.pathname?.startsWith('/api/token/?')) {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { items: [{ id: 17, name: 'WorkBuddy', key: 'sk-...abcd' }] },
          }
        }
        if (input.pathname === '/api/token/batch/keys') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { keys: { '17': 'sk-new-api-complete-key-123456' } },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const extraction = await service.extractOfficialApiKeys(site.id)

    expect(extraction.supported).toBe(true)
    expect(extraction.keys).toMatchObject([{ name: 'WorkBuddy', keyLast4: '3456' }])
    expect(extraction.keys[0]?.apiKey).toBe('sk-new-api-complete-key-123456')
  })
})

describe('NewApiService 黑与白福利站签到', () => {
  it('detects and clicks the visible verification control before reading the completed check-in result', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白', 'https://cdk.hybgzs.com')
    database.updateSiteAuth(site.id, {
      adapter: 'hybgzs-welfare',
      authStatus: 'valid',
      username: 'test-user',
      currencySymbol: '$',
      quotaPerUnit: 500_000,
      displayScale: 1,
    })
    database.saveSettings({ ...database.getSettings(), requestTimeoutSeconds: 0.05 })
    const authenticatedSite = database.getSite(site.id)!
    let challengeVisible = false
    let signed = false
    let verificationClicks = 0

    const page = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      getByRole: (role: string, options: { name: RegExp }) => ({
        count: async () => {
          if (role === 'button') return options.name.test('立即签到') ? 1 : 0
          return 0
        },
        click: async () => {
          if (role === 'button') {
            challengeVisible = true
            return
          }
          if (role === 'checkbox') {
            verificationClicks += 1
            challengeVisible = false
            signed = true
          }
        },
      }),
      getByText: (text: string) => ({
        locator: () => ({
          count: async () => text === '点击验证' && challengeVisible ? 1 : 0,
          click: async () => {
            verificationClicks += 1
            challengeVisible = false
            signed = true
          },
        }),
      }),
      evaluate: async (callback: unknown, argument?: { pathname?: string }) => {
        if (!argument?.pathname) {
          const source = String(callback)
          if (source.includes('document.title')) return { title: '黑与白福利站', text: '签到页面' }
          if (source.includes('challengeVisible')) return { signed, challengeVisible, errorMessage: null }
          return null
        }
        if (argument.pathname === '/api/user/info') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { user: { id: 'test-user', username: 'test-user' }, walletBalance: 500_000 } }
        }
        if (argument.pathname === '/api/wallet/balance') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { total: 750_000 } }
        }
        if (argument.pathname === '/api/checkin/config') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: signed
              ? { hasCheckedInToday: true, todayCheckinInfo: { rewardQuota: 250_000 } }
              : { hasCheckedInToday: false, todayExpectedReward: 250_000 },
          }
        }
        if (argument.pathname === '/api/checkin/status') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { enabled: true, capRequired: true } }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.checkinSite(authenticatedSite, run.id)

    expect(verificationClicks).toBe(1)
    expect(result).toMatchObject({
      status: 'success',
      rewardRaw: 250_000,
      balanceBeforeRaw: 750_000,
      balanceAfterRaw: 750_000,
      loginVerified: true,
    })
  })
})
