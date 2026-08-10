import { afterEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../security/secret-box.js'
import { AuthAssistantService } from './auth-assistant.js'
import type { BrowserManager } from './browser-manager.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { NewApiService, parseRemoteResponseBody } from './new-api.js'

const databases: AppDatabase[] = []

function createStorageBackedPage(
  storedUser: { id: number; username: string; quota: number },
  responseFor: (pathname: string) => unknown,
) {
  const requestedPaths: string[] = []
  const navigatedTo: string[] = []
  const page = {
    goto: async (url: string) => {
      navigatedTo.push(url)
    },
    evaluate: async (callback: unknown, input?: { pathname?: string }) => {
      if (input?.pathname) {
        requestedPaths.push(input.pathname)
        return responseFor(input.pathname)
      }
      const source = String(callback)
      if (source.includes('document.title')) return { title: 'Dashboard', text: '' }
      if (source.includes('localStorage.length')) return [storedUser.id]
      if (source.includes("getItem('user')") || source.includes('getItem("user")')) return storedUser
      if (source.includes('storage.key(') || source.includes('storage.getItem')) return storedUser
      return null
    },
  }
  return { page, requestedPaths, navigatedTo }
}

function preserveSiteResult(database: AppDatabase, siteId: number, result: Awaited<ReturnType<NewApiService['checkinSite']>>) {
  const { id: _id, siteName: _siteName, ...storedResult } = result
  database.applyResult(siteId, storedResult)
}

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

describe('NewApiService disabled New API check-in', () => {
  it('reads an aixoras-style dashboard token from localStorage during a balance-only refresh', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AtlasAPI', 'https://aixoras.com')
    database.updateSiteAuth(site.id, {
      adapter: 'unknown',
      authStatus: 'valid',
      lastBalanceRaw: 500_000,
      lastBalanceAmount: 1,
      lastError: '自动签到已关闭，未读取到最新余额',
    })
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('sessionStorage') && source.includes('token')) return 'aixoras-dashboard-token'
          return source.includes('document.title') ? { title: 'AtlasAPI', text: '' } : []
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { system_name: 'AtlasAPI', checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          if (input.headers?.Authorization !== 'Bearer aixoras-dashboard-token') {
            return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
          }
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 23, username: 'atlas-user', quota: 1_500_000 },
          }
        }
        return { httpStatus: 500, contentType: 'application/json', success: false, message: 'refresh must not be called' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      message: '自动签到已关闭，余额已刷新',
      balanceAfterRaw: 1_500_000,
      balanceAfterAmount: 3,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/status', '/api/user/self'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'new-api-modern',
      authStatus: 'valid',
      username: 'atlas-user',
      currencySymbol: '$',
      quotaPerUnit: 500_000,
      lastBalanceRaw: 1_500_000,
      lastBalanceAmount: 3,
      lastError: null,
    })
  })

  it('reads the latest balance without rotating the dashboard session when check-in is disabled', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('ooioo.work', 'https://ooioo.work')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 12 })
    const refreshedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) return String(callback).includes('document.title') ? { title: 'ooioo', text: '' } : []
        refreshedPaths.push(input.pathname)
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'test-user', quota: 42 },
          }
        }
        if (input.pathname === '/api/user/auth/refresh') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { access_token: 'rotated-token', user: { id: 7, username: 'test-user', quota: 12 } },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.checkinSite(site, run.id)

    expect(result).toMatchObject({ status: 'disabled', message: '签到功能未启用，余额已刷新', balanceAfterRaw: 42, loginVerified: true })
    expect(refreshedPaths).toEqual(['/api/status', '/api/user/self'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'new-api-modern',
      authStatus: 'valid',
      username: 'test-user',
      lastBalanceRaw: 42,
      lastError: null,
    })
  })

  it('reuses the access token emitted by the page bootstrap without issuing another refresh', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('ooioo.work', 'https://ooioo.work')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 12 })
    const requestedPaths: string[] = []
    const responseHandlers: Array<(response: unknown) => void> = []
    const page = {
      goto: async () => {
        for (const handler of [...responseHandlers]) {
          handler({
            url: () => 'https://ooioo.work/api/user/auth/refresh',
            json: async () => ({
              success: true,
              data: {
                access_token: 'page-bootstrap-access-token',
                access_expires_at: Math.floor(Date.now() / 1000) + 60,
              },
            }),
          })
        }
      },
      on: (event: string, handler: (value: unknown) => void) => {
        if (event === 'response') responseHandlers.push(handler)
      },
      off: (event: string, handler: (value: unknown) => void) => {
        if (event !== 'response') return
        const index = responseHandlers.indexOf(handler)
        if (index >= 0) responseHandlers.splice(index, 1)
      },
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) return { title: 'ooioo', text: '' }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          expect(input.headers?.Authorization).toBe('Bearer page-bootstrap-access-token')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'test-user', quota: 84 },
          }
        }
        return { httpStatus: 500, contentType: 'application/json', success: false, message: 'refresh must not be called' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.checkinSite(site, run.id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 84, loginVerified: true })
    expect(requestedPaths).toEqual(['/api/status', '/api/user/self'])
  })
})

describe('NewApiService YiAPI balance', () => {
  it('reads YiAPI profile balance with its dashboard access token', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('yiapi.ai', 'https://yiapi.ai')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 3.5 })
    const authorizedSite = database.getSite(site.id)!
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          expect(String(callback)).toContain('auth_token')
          return 'yiapi-dashboard-access-token'
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/user/profile') {
          expect(input.headers?.Authorization).toBe('Bearer yiapi-dashboard-access-token')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 42, username: 'yi-user', balance: 12.75 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(authorizedSite, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceBeforeRaw: 3.5,
      balanceAfterRaw: 12.75,
      balanceAfterAmount: 12.75,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/user/profile'])
  })
})

describe('NewApiService dashboard balance fallback', () => {
  it('reads a legacy New API balance without opening /dashboard when check-in is disabled', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('New API dashboard', 'https://new-api-dashboard.example')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const navigatedTo: string[] = []
    const requestedPaths: string[] = []
    const page = {
      goto: async (url: string) => {
        navigatedTo.push(url)
      },
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) return { title: 'New API dashboard', text: '' }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'fastai-user', quota: 42 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 42, loginVerified: true })
    expect(navigatedTo).toEqual(['https://new-api-dashboard.example'])
    expect(requestedPaths).toEqual(['/api/status', '/api/user/self'])
  })

  it('reads the FastAI Token USD balance through its Sub2API auth profile', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('fastaitoken.com', 'https://www.fastaitoken.com')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const requestedPaths: string[] = []
    const navigatedTo: string[] = []
    const page = {
      goto: async (url: string) => {
        navigatedTo.push(url)
      },
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('auth_token')) return 'fastai-v1-access-token'
          return { title: 'FastAI Token', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          expect(input.headers?.Authorization).toBe('Bearer fastai-v1-access-token')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'fastai-user', balance: 42.75, quota: 21_375_000 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 42.75,
      balanceAfterAmount: 42.75,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
    expect(navigatedTo).toEqual(['https://www.fastaitoken.com', 'https://www.fastaitoken.com/dashboard'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'sub2api',
      authStatus: 'valid',
      lastBalanceRaw: 42.75,
      lastBalanceAmount: 42.75,
      currencySymbol: '$',
      quotaPerUnit: 1,
    })
  })

  it('falls back to the imported cookie session when the FastAI access token is missing', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('FastAI cookie', 'https://www.fastaitoken.com')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('auth_token')) return null
          return { title: 'FastAI Token', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          expect(input.headers?.Authorization).toBeUndefined()
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 9, username: 'cookie-user', balance: 8.25 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 8.25,
      balanceAfterAmount: 8.25,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
    expect(database.getSite(site.id)).toMatchObject({ adapter: 'sub2api', lastBalanceRaw: 8.25, lastBalanceAmount: 8.25 })
  })

  it('prefers the imported FastAI cookie session over refreshing an expired token', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('FastAI token refresh guard', 'https://www.fastaitoken.com')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('auth_token')) return 'fastai-expired-token'
          return { title: 'FastAI Token', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          if (input.headers?.Authorization) {
            expect(input.headers.Authorization).toBe('Bearer fastai-expired-token')
            return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
          }
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 10, username: 'cookie-user', balance: 6.5 },
          }
        }
        if (input.pathname === '/api/v1/user/profile') {
          return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
        }
        if (input.pathname === '/api/v1/auth/refresh') {
          throw new Error('refresh must not be called when the cookie session works')
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 6.5,
      balanceAfterAmount: 6.5,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me', '/api/v1/user/profile', '/api/v1/auth/me'])
    expect(requestedPaths).not.toContain('/api/v1/auth/refresh')
    expect(database.getSite(site.id)).toMatchObject({ adapter: 'sub2api', authStatus: 'valid', lastBalanceRaw: 6.5 })
  })

  it('persists rotated FastAI tokens back into the auth snapshot', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('FastAI token rotation', 'https://www.fastaitoken.com')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const secrets = createSecretBox('fastai-token-rotation-test-key')
    database.saveSiteAuthSnapshot(site.id, secrets.encrypt(JSON.stringify({
      siteOrigin: 'https://www.fastaitoken.com',
      cookies: [],
      localStorageByHost: {
        'www.fastaitoken.com': {
          auth_token: 'old-access',
          refresh_token: 'old-refresh',
        },
      },
      updatedAt: new Date().toISOString(),
    })))
    const authAssistant = new AuthAssistantService(database, secrets, new EventBus())
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      addInitScript: async () => undefined,
      reload: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string>; accessToken?: string; refreshToken?: string | null }) => {
        if (!input?.pathname) {
          if (String(callback).includes('auth_token')) return 'old-access'
          if (String(callback).includes('refresh_token')) return 'old-refresh'
          return { title: 'FastAI Token', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          if (input.headers?.Authorization === 'Bearer new-access') {
            return {
              httpStatus: 200,
              contentType: 'application/json',
              success: true,
              data: { id: 11, username: 'fastai-user', balance: 5.25 },
            }
          }
          return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
        }
        if (input.pathname === '/api/v1/user/profile') {
          return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
        }
        if (input.pathname === '/api/v1/auth/refresh') {
          expect(input.headers?.['Content-Type']).toBe('application/json')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { access_token: 'new-access', refresh_token: 'new-refresh' },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus(), { authAssistant })
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 5.25, balanceAfterAmount: 5.25, loginVerified: true })
    expect(requestedPaths).toContain('/api/v1/auth/refresh')
    const snapshot = await authAssistant.getSnapshot(site.id)
    expect(snapshot?.localStorageByHost['www.fastaitoken.com']).toMatchObject({
      auth_token: 'new-access',
      refresh_token: 'new-refresh',
    })
  })

  it('continues from FastAI auth identity to user profile when auth/me has no balance', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('FastAI Token profile', 'https://www.fastaitoken.com')
    database.updateSiteAuth(site.id, { adapter: 'sub2api', authStatus: 'valid', lastBalanceRaw: 1 })
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('auth_token')) return 'fastai-profile-access-token'
          return { title: 'FastAI Token', text: '' }
        }
        requestedPaths.push(input.pathname)
        expect(input.headers?.Authorization).toBe('Bearer fastai-profile-access-token')
        if (input.pathname === '/api/v1/auth/me') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'fastai-user' },
          }
        }
        if (input.pathname === '/api/v1/user/profile') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 7, username: 'fastai-user', balance: 7.69 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 7.69, balanceAfterAmount: 7.69, loginVerified: true })
    expect(requestedPaths).toEqual(['/api/v1/auth/me', '/api/v1/user/profile'])
  })
})

describe('NewApiService TrueSOTA balance', () => {
  it('reads the dollar balance from the Sub2API-compatible auth endpoint', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('true-sota.com', 'https://true-sota.com')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 3.5 })
    const authorizedSite = database.getSite(site.id)!
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) {
          expect(String(callback)).toContain('auth_token')
          return 'true-sota-access-token'
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { user: { id: 19, username: 'sota-user', balance: 12.34 } },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(authorizedSite, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceBeforeRaw: 3.5,
      balanceAfterRaw: 12.34,
      balanceAfterAmount: 12.34,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'sub2api',
      authStatus: 'valid',
      lastBalanceRaw: 12.34,
      lastBalanceAmount: 12.34,
    })
  })

  it('uses the TrueSOTA balance path even when the site was previously classified as Sub2API', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('true-sota.com', 'https://true-sota.com')
    database.updateSiteAuth(site.id, { adapter: 'sub2api', authStatus: 'valid', lastBalanceRaw: 3.5 })
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('document.title')) return { title: '', text: '' }
          if (source.includes('auth_token')) return 'true-sota-access-token'
          return null
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 19, username: 'sota-user', balance: 12.34 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.checkinSite(site, run.id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 12.34, loginVerified: true })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
  })
})

describe('NewApiService channel import', () => {
  it('reads a complete New API key from the batch key endpoint when the list is masked', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('New API 测试站', 'https://new-api.example')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid' })

    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async (_callback: unknown, input: { pathname?: string }) => {
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { system_name: 'New API 测试站', quota_per_unit: 500_000 },
          }
        }
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
        if (argument.pathname === '/api/wallet/mainsite-balance?force=1') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { balance: 1_298_180_000, connected: true } }
        }
        if (argument.pathname === '/api/wallet/balance') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { total: 750_000, wallet: { balance: 37_500_000 }, mainSite: { balance: 1_298_180_000 } } }
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
      balanceBeforeRaw: 1_298_180_000,
      balanceAfterRaw: 1_298_180_000,
      loginVerified: true,
    })
  })
})

describe('NewApiService known balance-only sites', () => {
  it('reads Home - AI Gateway through its Sub2API auth profile', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Home - AI Gateway', 'https://gateai.cc')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 1 })
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('auth_token')) return 'gateai-access-token'
          return { title: 'Home - AI Gateway', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          expect(input.headers?.Authorization).toBe('Bearer gateai-access-token')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 88, username: 'gateai-user', balance: 9.99 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 9.99,
      balanceAfterAmount: 9.99,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'sub2api',
      authStatus: 'valid',
      username: 'gateai-user',
      currencySymbol: '$',
      quotaPerUnit: 1,
      lastBalanceRaw: 9.99,
      lastBalanceAmount: 9.99,
    })
  })

  it('reads Aihub.top through its Sub2API auth profile behind a browser challenge', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Aihub', 'https://aihub.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const requestedPaths: string[] = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('auth_token')) return 'aihub-access-token'
          return { title: 'Just a moment...', text: 'Performing browser verification' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/v1/auth/me') {
          expect(input.headers?.Authorization).toBe('Bearer aihub-access-token')
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 8, username: 'aihub-user', balance: 8.62, quota: 8.62 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 8.62,
      balanceAfterAmount: 8.62,
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/v1/auth/me'])
    expect(database.getSite(site.id)).toMatchObject({
      adapter: 'sub2api',
      authStatus: 'valid',
      username: 'aihub-user',
      currencySymbol: '$',
      quotaPerUnit: 1,
      lastBalanceRaw: 8.62,
      lastBalanceAmount: 8.62,
    })
  })

  it('refreshes AnyRouter from /console without opening the check-in homepage', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AnyRouter', 'https://anyrouter.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const requestedPaths: string[] = []
    const navigatedTo: string[] = []
    const page = {
      goto: async (url: string) => { navigatedTo.push(url) },
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('localStorage')) return 'anyrouter-access-token'
          return { title: 'AnyRouter dashboard', text: '' }
        }
        requestedPaths.push(input.pathname)
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          expect(input.headers?.Authorization).toBeUndefined()
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 9, username: 'anyrouter-user', quota: 2_000_000 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const run = database.startRun('manual')

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, run.id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 2_000_000,
      balanceAfterAmount: 4,
      loginVerified: true,
    })
    expect(navigatedTo).toEqual(['https://anyrouter.top/console'])
    expect(requestedPaths).toEqual(['/api/status', '/api/user/self'])
  })

  it('does not overwrite an Any Router balance with an anonymous zero response after a historical guest identity was saved', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AnyRouter', 'https://anyrouter.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    database.updateSiteAuth(site.id, {
      adapter: 'new-api-modern',
      authStatus: 'valid',
      username: 'guest',
      quotaPerUnit: 500_000,
      lastBalanceRaw: 2_000_000,
      lastBalanceAmount: 4,
    })
    const balanceUpdatedAtBefore = database.getSite(site.id)!.lastBalanceUpdatedAt
    const page = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('document.title')) return { title: 'AnyRouter console', text: '' }
          if (source.includes('const ids')) return []
          return null
        }
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 0, username: 'guest', quota: 0 },
          }
        }
        return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'disabled',
      message: '自动签到已关闭，未读取到最新余额',
      balanceAfterRaw: 2_000_000,
      loginVerified: true,
    })
    expect(database.getSite(site.id)).toMatchObject({
      authStatus: 'valid',
      lastBalanceRaw: 2_000_000,
      lastBalanceAmount: 4,
    })
    expect(database.getSite(site.id)!.lastBalanceUpdatedAt).toBe(balanceUpdatedAtBefore)
  })

  it('accepts a zero Any Router balance for an identified user', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AnyRouter', 'https://anyrouter.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) return String(callback).includes('document.title') ? { title: 'AnyRouter console', text: '' } : null
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 9, username: 'anyrouter-user', quota: 0 },
          }
        }
        return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 0, balanceAfterAmount: 0, loginVerified: true })
    expect(database.getSite(site.id)).toMatchObject({ authStatus: 'valid', username: 'anyrouter-user', legacyUserId: 9, lastBalanceRaw: 0 })
  })

  it('retries Any Router after the console finishes restoring its browser session', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AnyRouter', 'https://anyrouter.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const waits: number[] = []
    let selfRequests = 0
    const page = {
      goto: async () => undefined,
      waitForTimeout: async (milliseconds: number) => { waits.push(milliseconds) },
      evaluate: async (callback: unknown, input?: { pathname?: string }) => {
        if (!input?.pathname) return String(callback).includes('document.title') ? { title: 'AnyRouter console', text: '' } : null
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self') {
          selfRequests += 1
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: selfRequests === 1
              ? { id: 0, username: 'guest', quota: 0 }
              : { id: 9, username: 'anyrouter-user', quota: 2_000_000 },
          }
        }
        return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 2_000_000, balanceAfterAmount: 4, loginVerified: true })
    expect(waits).toEqual([800])
    expect(selfRequests).toBe(2)
  })

  it('prefers Any Router browser-cookie balance when the bearer response is zero', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('AnyRouter', 'https://anyrouter.top')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const requests: Array<{ pathname: string; authorization: string | undefined }> = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          if (String(callback).includes('localStorage')) return 'anyrouter-access-token'
          return { title: 'AnyRouter dashboard', text: '' }
        }
        requests.push({ pathname: input.pathname, authorization: input.headers?.Authorization })
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self' && input.headers?.Authorization) {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 9, username: 'anyrouter-user', quota: 0 },
          }
        }
        if (input.pathname === '/api/user/self') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 9, username: 'anyrouter-user', quota: 2_000_000 },
          }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 2_000_000, balanceAfterAmount: 4, loginVerified: true })
    expect(requests).toEqual([
      { pathname: '/api/status', authorization: undefined },
      { pathname: '/api/user/self', authorization: undefined },
    ])
  })

  it('reads a legacy New API user id stored as uid', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('42 API', 'https://api.42w.shop')
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const requested: Array<{ pathname: string; userId: string | undefined }> = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('uid')) return '42'
          if (source.includes('document.title')) return { title: '42 API', text: '' }
          return []
        }
        requested.push({ pathname: input.pathname, userId: input.headers?.['New-API-User'] })
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: false, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self' && input.headers?.['New-API-User'] === '42') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 42, username: 'forty-two', quota: 1_234_000 },
          }
        }
        return { httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({ status: 'disabled', balanceAfterRaw: 1_234_000, balanceAfterAmount: 2.47, loginVerified: true })
    expect(requested).toEqual([
      { pathname: '/api/status', userId: undefined },
      { pathname: '/api/user/self', userId: undefined },
      { pathname: '/api/user/self', userId: '42' },
    ])
  })
})

describe('New API response parsing', () => {
  it('parses a JSON response body even when the content type is not JSON', () => {
    expect(parseRemoteResponseBody({
      httpStatus: 200,
      contentType: 'text/plain; charset=utf-8',
      body: '{"success":true,"data":{"quota":42}}',
    })).toMatchObject({
      httpStatus: 200,
      success: true,
      data: { quota: 42 },
    })
  })
})

describe('NewApiService keeps valid sessions on proxy error pages', () => {
  it('reports browser verification without refreshing from stored dashboard data', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Any Router', 'https://anyrouter.top')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 500_000 })
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const { page, requestedPaths, navigatedTo } = createStorageBackedPage(
      { id: 9, username: 'anyrouter-user', quota: 2_000_000 },
      () => ({ httpStatus: 403, contentType: 'text/html; charset=UTF-8', success: false, message: '站点要求浏览器验证，请人工处理' }),
    )
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'manual_required',
      message: '线上服务器浏览器被站点验证拦截，请在本机已授权浏览器完成验证后重新刷新余额',
      loginVerified: true,
    })
    expect(navigatedTo).toEqual(['https://anyrouter.top/console'])
    expect(requestedPaths).toEqual(['/api/status', '/api/user/self', '/api/user/self', '/api/user/auth/refresh'])
    preserveSiteResult(database, site.id, result)
    expect(database.getSite(site.id)).toMatchObject({ authStatus: 'valid', lastBalanceRaw: 500_000 })
  })

  it('does not use a stored dashboard user as proof of a fresh login', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Stale Dashboard', 'https://stale-dashboard.example')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid', lastBalanceRaw: 500_000 })
    database.updateSiteCheckinMode(site.id, 'balance_only')
    const { page, requestedPaths } = createStorageBackedPage(
      { id: 9, username: 'stale-user', quota: 2_000_000 },
      () => ({ httpStatus: 200, contentType: 'text/plain; charset=UTF-8', success: false, message: '站点返回了非 JSON 响应' }),
    )
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'failed',
      message: '站点 API 返回了页面而非 JSON，已保留当前登录状态，请确认站点 API 地址',
      loginVerified: true,
    })
    expect(requestedPaths.length).toBeGreaterThan(0)
    expect(database.getSite(site.id)).toMatchObject({ authStatus: 'valid', lastBalanceRaw: 500_000 })
  })

  it('stops check-in and refresh immediately when the site redirects to login', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('Login Redirect', 'https://login-redirect.example')
    const requestedPaths: string[] = []
    const page = {
      url: () => 'https://login-redirect.example/login',
      goto: async () => undefined,
      evaluate: async (_callback: unknown, input?: { pathname?: string }) => {
        if (input?.pathname) requestedPaths.push(input.pathname)
        return null
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())

    const checkin = await service.checkinSite(site, database.startRun('manual').id)
    const refresh = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(checkin).toMatchObject({ status: 'manual_required', message: '站点已跳转到登录页，请重新授权', loginVerified: false })
    expect(refresh).toMatchObject({ status: 'manual_required', message: '站点已跳转到登录页，请重新授权', loginVerified: false })
    expect(requestedPaths).toEqual([])
  })

  it('moves 42 API to balance-only mode when its authenticated check-in endpoint returns an HTML 404', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('42 API', 'https://api.42w.shop')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid' })
    const requested: Array<{ pathname: string; userId: string | undefined }> = []
    const page = {
      goto: async () => undefined,
      evaluate: async (callback: unknown, input?: { pathname?: string; headers?: Record<string, string> }) => {
        if (!input?.pathname) {
          const source = String(callback)
          if (source.includes('uid')) return '42'
          if (source.includes('localStorage.length')) return []
          if (source.includes('document.title')) return { title: '42 API', text: '' }
          return null
        }
        requested.push({ pathname: input.pathname, userId: input.headers?.['New-API-User'] })
        if (input.pathname === '/api/status') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { checkin_enabled: true, quota_per_unit: 500_000 },
          }
        }
        if (input.pathname === '/api/user/self' && input.headers?.['New-API-User'] === '42') {
          return {
            httpStatus: 200,
            contentType: 'application/json',
            success: true,
            data: { id: 42, username: 'forty-two', quota: 1_234_000 },
          }
        }
        if (input.pathname.startsWith('/api/user/checkin?month=')) {
          return { httpStatus: 404, contentType: 'text/html; charset=UTF-8', success: false, message: '站点返回了非 JSON 响应' }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    }
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const result = await service.checkinSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'disabled',
      message: '该站点不支持自动签到，余额已刷新',
      balanceAfterRaw: 1_234_000,
      balanceAfterAmount: 2.47,
      loginVerified: true,
    })
    expect(requested).toEqual([
      { pathname: '/api/status', userId: undefined },
      { pathname: '/api/user/self', userId: '42' },
      { pathname: '/api/user/self', userId: '42' },
      { pathname: expect.stringMatching(/^\/api\/user\/checkin\?month=/), userId: '42' },
    ])
    expect(database.getSite(site.id)).toMatchObject({
      checkinMode: 'balance_only',
      authStatus: 'valid',
      lastBalanceRaw: 1_234_000,
      lastBalanceAmount: 2.47,
    })
    preserveSiteResult(database, site.id, result)
    expect(database.getSite(site.id)?.authStatus).toBe('valid')
  })

  it('reports browser verification as manual work while keeping 黑与白福利站 NEXT logged in', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白福利站 NEXT', 'https://cdk.hybgzs.com')
    database.updateSiteAuth(site.id, { adapter: 'hybgzs-welfare', authStatus: 'valid' })
    const { page, requestedPaths } = createStorageBackedPage(
      { id: 1, username: 'unused', quota: 1 },
      () => ({ httpStatus: 403, contentType: 'text/html; charset=UTF-8', success: false, message: '站点要求浏览器验证，请人工处理' }),
    )
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'manual_required',
      message: '线上服务器浏览器被站点验证拦截，请在本机已授权浏览器完成验证后重新刷新余额',
      loginVerified: true,
    })
    expect(requestedPaths).toEqual(['/api/user/info'])
    preserveSiteResult(database, site.id, result)
    expect(database.getSite(site.id)?.authStatus).toBe('valid')
  })

  it('falls back to mainSite.balance when the force refresh endpoint is rate limited', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白福利站 NEXT', 'https://cdk.hybgzs.com')
    database.updateSiteAuth(site.id, { adapter: 'hybgzs-welfare', authStatus: 'valid' })
    const { page, requestedPaths } = createStorageBackedPage(
      { id: 1, username: 'test-user', quota: 1 },
      (pathname) => {
        if (pathname === '/api/user/info') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { user: { id: '1', username: 'test-user' } } }
        }
        if (pathname === '/api/wallet/mainsite-balance?force=1') {
          return { httpStatus: 429, contentType: 'application/json', success: false, message: '请求频繁，请稍后再试' }
        }
        if (pathname === '/api/wallet/balance') {
          return { httpStatus: 200, contentType: 'application/json', success: true, data: { total: 37_500_000, wallet: { balance: 37_500_000 }, mainSite: { balance: 1_298_180_000 } } }
        }
        return { httpStatus: 404, contentType: 'application/json', success: false, message: 'Not Found' }
      },
    )
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({
      status: 'disabled',
      balanceAfterRaw: 1_298_180_000,
      loginVerified: true,
    })
    expect(requestedPaths).toContain('/api/wallet/mainsite-balance?force=1')
    expect(requestedPaths).toContain('/api/wallet/balance')
  })

  it('marks a JSON 401 as an actual authentication failure', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白福利站 NEXT', 'https://cdk.hybgzs.com')
    database.updateSiteAuth(site.id, { adapter: 'hybgzs-welfare', authStatus: 'valid' })
    const { page } = createStorageBackedPage(
      { id: 1, username: 'unused', quota: 1 },
      () => ({ httpStatus: 401, contentType: 'application/json', success: false, message: 'Unauthorized' }),
    )
    const browser = {
      run: async (_options: unknown, task: (_context: unknown, activePage: typeof page) => Promise<unknown>) => task({}, page),
    } as unknown as BrowserManager
    const service = new NewApiService(database, browser, new EventBus())
    const result = await service.refreshBalanceSite(database.getSite(site.id)!, database.startRun('manual').id)

    expect(result).toMatchObject({ status: 'manual_required', loginVerified: false, message: '登录状态已失效，请重新授权' })
    preserveSiteResult(database, site.id, result)
    expect(database.getSite(site.id)?.authStatus).toBe('manual_required')
  })
})
