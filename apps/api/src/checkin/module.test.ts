import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpsAgent } from '../agent/ops-agent.js'
import { gatewayErrorHandler } from '../http/proxy-routes.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import { LocalExecutionService, type LocalExecutionPersistInput } from './local-execution.js'
import { registerCheckinRoutes, type CheckinModule } from './module.js'
import { SiteIconService } from './site-icon.js'
import type { CheckinResult } from './types.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('check-in channel import routes', () => {
  it('prepares imported channels in auto protocol instead of the site-specific protocol', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('New API Test', 'https://new-api.example')
    database.updateSiteAuth(site.id, { adapter: 'unknown', authStatus: 'valid' })

    const prepareChannelImport = vi.fn(async () => ({
      candidateId: 'f4be1722-7e14-4b31-b3f3-0ad861e1c4f7',
      siteName: site.name,
      keyName: 'WorkBuddy',
      baseUrl: 'https://new-api.example',
      protocol: 'auto',
      models: [],
      keyLast4: '3456',
      validation: { status: 'not_probed', ok: false, chatOk: false, streamOk: false, latencyMs: 0, balance: null, balanceCurrency: null, balanceStatus: 'unknown' },
      matchedChannel: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))
    const newApi = {
      extractOfficialApiKeys: vi.fn(async () => ({
        supported: true,
        baseUrl: 'https://new-api.example',
        protocol: 'new-api',
        keys: [{ id: '1', name: 'WorkBuddy', apiKey: 'sk-new-api-complete-key-123456', keyLast4: '3456' }],
      })),
    }
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      siteIcons: new SiteIconService(database, fetch),
      newApi,
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: { prepareChannelImport } as unknown as OpsAgent })

    const response = await app.inject({
      method: 'POST',
      url: `/admin/checkin/sites/${site.id}/channel-import/prepare`,
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ candidates: [{ protocol: 'auto' }] })
    expect(prepareChannelImport).toHaveBeenCalledWith(expect.objectContaining({
      siteId: site.id,
      baseUrl: 'https://new-api.example',
      apiKey: 'sk-new-api-complete-key-123456',
      protocol: 'auto',
    }))

    await app.close()
  })
})

describe('check-in site icon routes', () => {
  it('accepts and serves a base64 PNG data URL larger than the former URL limit', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const image = Buffer.concat([onePixelPng, Buffer.alloc(2_048)])
    const faviconUrl = `data:image/png;base64,${image.toString('base64')}`
    expect(faviconUrl.length).toBeGreaterThan(2_000)

    const fetcher = vi.fn(async () => {
      throw new Error('data URL icons must not use the network')
    })
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      siteIcons: new SiteIconService(database, fetcher as unknown as typeof fetch),
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const created = await app.inject({
      method: 'POST',
      url: '/admin/checkin/sites',
      payload: { baseUrl: 'https://relay.example', faviconUrl },
    })

    expect(created.statusCode).toBe(201)
    const site = created.json<{ id: number; faviconUrl: string }>()
    expect(site.faviconUrl).toBe(faviconUrl)

    const icon = await app.inject({ method: 'GET', url: `/admin/checkin/sites/${site.id}/favicon` })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect(icon.rawPayload).toEqual(image)
    expect(fetcher).not.toHaveBeenCalled()

    await app.close()
  })

  it('persists the selected check-in mode for single and bulk site creation', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      siteIcons: new SiteIconService(database, fetch),
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const single = await app.inject({
      method: 'POST',
      url: '/admin/checkin/sites',
      payload: { baseUrl: 'https://balance-only.example', checkinMode: 'balance_only' },
    })
    expect(single.statusCode).toBe(201)
    expect(single.json<{ checkinMode: string }>().checkinMode).toBe('balance_only')

    const bulk = await app.inject({
      method: 'POST',
      url: '/admin/checkin/sites/bulk',
      payload: { urls: ['https://welfare-one.example', 'https://welfare-two.example'], checkinMode: 'checkin' },
    })
    expect(bulk.statusCode).toBe(201)
    expect(bulk.json<{ created: Array<{ checkinMode: string }> }>().created.every((site) => site.checkinMode === 'checkin')).toBe(true)

    await app.close()
  })

  it('switches an existing site between check-in and balance-only mode', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      siteIcons: new SiteIconService(database, fetch),
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const created = await app.inject({
      method: 'POST',
      url: '/admin/checkin/sites',
      payload: { baseUrl: 'https://switch.example' },
    })
    const site = created.json<{ id: number; checkinMode: string }>()
    expect(site.checkinMode).toBe('checkin')

    const relay = await app.inject({
      method: 'PATCH',
      url: `/admin/checkin/sites/${site.id}`,
      payload: { checkinMode: 'balance_only' },
    })
    expect(relay.statusCode).toBe(200)
    expect(relay.json<{ checkinMode: string }>().checkinMode).toBe('balance_only')

    const welfare = await app.inject({
      method: 'PATCH',
      url: `/admin/checkin/sites/${site.id}`,
      payload: { checkinMode: 'checkin' },
    })
    expect(welfare.json<{ checkinMode: string }>().checkinMode).toBe('checkin')

    await app.close()
  })

  it('exposes one-time fixed-domain local execution endpoints for the extension', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const site = database.createSite('黑与白福利站', 'https://cdk.hybgzs.com')
    const persist = vi.fn(async ({ siteId, operation, report }: LocalExecutionPersistInput): Promise<CheckinResult> => ({
      id: 9,
      runId: 7,
      siteId,
      siteName: database.getSite(siteId)?.name ?? '黑与白福利站',
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
    }))
    const localExecution = new LocalExecutionService(database, new EventBus(), persist)
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      siteIcons: new SiteIconService(database, fetch),
      localExecution,
      coordinator: { getActiveRun: vi.fn(() => null) },
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const created = await app.inject({
      method: 'POST',
      url: `/admin/checkin/sites/${site.id}/auth-assistant/local-execution`,
      payload: { operation: 'checkin' },
    })
    expect(created.statusCode).toBe(201)
    const task = created.json<{ executionId: string; code: string; siteUrl: string; domain: string; operation: string }>()
    expect(task).toMatchObject({ siteUrl: site.baseUrl, domain: 'cdk.hybgzs.com', operation: 'checkin' })

    const claim = await app.inject({
      method: 'POST',
      url: '/auth-assistant/local-execution/claim',
      headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      payload: { code: task.code, hostname: 'cdk.hybgzs.com' },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.headers['access-control-allow-origin']).toBe('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const claimed = claim.json<{ executionId: string; resultToken: string; operation: string }>()
    expect(claimed).toMatchObject({ executionId: task.executionId, operation: 'checkin' })

    const tampered = await app.inject({
      method: 'POST',
      url: '/auth-assistant/local-execution/report',
      headers: { 'x-autoapi-assistant-token': claimed.resultToken },
      payload: {
        executionId: task.executionId,
        operation: 'balance_refresh',
        status: 'success',
        message: '签到成功',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })
    expect(tampered.statusCode).toBe(400)
    expect(persist).not.toHaveBeenCalled()

    const reported = await app.inject({
      method: 'POST',
      url: '/auth-assistant/local-execution/report',
      headers: { 'x-autoapi-assistant-token': claimed.resultToken },
      payload: {
        executionId: task.executionId,
        status: 'success',
        message: '签到成功',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })
    expect(reported.statusCode).toBe(200)
    expect(persist).toHaveBeenCalledWith({
      siteId: site.id,
      operation: 'checkin',
      report: expect.objectContaining({ executionId: task.executionId, balanceRaw: 1_500_000, rewardRaw: 500_000 }),
    })

    const status = await app.inject({
      method: 'GET',
      url: `/admin/checkin/sites/${site.id}/auth-assistant/local-execution/${task.executionId}`,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ status: 'success', operation: 'checkin', result: { balanceAfterAmount: 3 } })
    expect(status.json()).not.toHaveProperty('code')

    const replay = await app.inject({
      method: 'POST',
      url: '/auth-assistant/local-execution/report',
      headers: { 'x-autoapi-assistant-token': claimed.resultToken },
      payload: {
        executionId: task.executionId,
        status: 'success',
        message: '重复上报',
        balanceRaw: 1_500_000,
        rewardRaw: 500_000,
      },
    })
    expect(replay.statusCode).toBe(409)

    const unsupported = database.createSite('其他站点', 'https://hybgzs.com')
    const unsupportedTask = await app.inject({
      method: 'POST',
      url: `/admin/checkin/sites/${unsupported.id}/auth-assistant/local-execution`,
      payload: { operation: 'balance_refresh' },
    })
    expect(unsupportedTask.statusCode).toBe(422)

    const cancellable = await app.inject({
      method: 'POST',
      url: `/admin/checkin/sites/${site.id}/auth-assistant/local-execution`,
      payload: { operation: 'balance_refresh' },
    })
    const cancellableTask = cancellable.json<{ executionId: string }>()
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/admin/checkin/sites/${site.id}/auth-assistant/local-execution/${cancellableTask.executionId}`,
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toMatchObject({ executionId: cancellableTask.executionId, status: 'cancelled' })

    await app.close()
  })
})

describe('check-in run cancellation routes', () => {
  it('cancels a single running site for the active run', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const cancelActiveSite = vi.fn(async () => database.startRun('manual'))
    const checkinModule = {
      db: database,
      events: { emit: vi.fn() },
      coordinator: { cancelActiveSite },
    } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const response = await app.inject({
      method: 'POST',
      url: '/admin/checkin/runs/5/sites/7/cancel',
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(cancelActiveSite).toHaveBeenCalledWith(5, 7)
    await app.close()
  })
})

describe('check-in site reorder route', () => {
  it('persists the requested order and emits a state change', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const a = database.createSite('A', 'https://a.example')
    const b = database.createSite('B', 'https://b.example')
    const c = database.createSite('C', 'https://c.example')
    const emit = vi.fn()
    const checkinModule = { db: database, events: { emit } } as unknown as CheckinModule
    const app = Fastify()
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const response = await app.inject({
      method: 'POST',
      url: '/admin/checkin/sites/reorder',
      payload: { siteIds: [c.id, a.id, b.id] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(database.listSites().map((site) => site.id)).toEqual([c.id, a.id, b.id])
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'state_changed' }))
    await app.close()
  })

  it('rejects an empty site id list', async () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const checkinModule = { db: database, events: { emit: vi.fn() } } as unknown as CheckinModule
    const app = Fastify()
    app.setErrorHandler(gatewayErrorHandler())
    await registerCheckinRoutes(app, checkinModule, async () => undefined, { agent: {} as OpsAgent })

    const response = await app.inject({ method: 'POST', url: '/admin/checkin/sites/reorder', payload: { siteIds: [] } })
    expect(response.statusCode).toBe(400)
    await app.close()
  })
})
