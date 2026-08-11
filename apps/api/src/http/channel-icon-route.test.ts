import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpsAgent } from '../agent/ops-agent.js'
import type { GatewayStore } from '../domain/store.js'
import type { GatewayRouter } from '../gateway/router.js'
import type { SiteIconService } from '../checkin/site-icon.js'
import type { AppDatabase } from '../checkin/db.js'
import type { Site } from '../checkin/types.js'
import { registerAdminRoutes } from './admin-routes.js'
import type { Channel } from '../domain/types.js'
import type { AdminAuthService } from '../security/admin-auth.js'

const resources: Array<ReturnType<typeof Fastify>> = []

afterEach(async () => {
  await Promise.all(resources.splice(0).map((app) => app.close()))
})

describe('admin channel icon proxy', () => {
  it('returns a server-fetched icon for a channel without a check-in link', async () => {
    const channel = { id: '00000000-0000-4000-8000-000000000001', baseUrl: 'https://relay.example/v1' } as Channel
    const asset = { body: new Uint8Array([1, 2, 3]), contentType: 'image/png' }
    const store = { getChannel: vi.fn(async () => channel) } as unknown as GatewayStore
    const siteIcons = { getExternalIconAsset: vi.fn(async () => asset) } as unknown as SiteIconService
    const app = Fastify({ logger: false })
    resources.push(app)

    await registerAdminRoutes(app, {
      store,
      agent: {} as OpsAgent,
      router: {} as GatewayRouter,
      adminAuth: { isValidToken: () => true } as unknown as AdminAuthService,
      gatewayBaseUrl: 'http://localhost:8080/v1',
      version: 'test',
      siteIcons,
    })

    const result = await app.inject({
      method: 'GET',
      url: `/admin/channels/${channel.id}/favicon`,
      headers: { authorization: 'Bearer test-admin-token' },
    })

    expect(result.statusCode).toBe(200)
    expect(result.headers['content-type']).toContain('image/png')
    expect(result.headers['cache-control']).toContain('max-age=86400')
    expect([...result.rawPayload]).toEqual([1, 2, 3])
    expect(siteIcons.getExternalIconAsset).toHaveBeenCalledWith(channel.baseUrl)
  })

  it('uses the linked check-in site asset before resolving a generic favicon', async () => {
    const channel = { id: '00000000-0000-4000-8000-000000000002', baseUrl: 'https://relay.example/v1' } as Channel
    const site = { id: 7, baseUrl: 'https://checkin.example' } as Site
    const asset = { body: new Uint8Array([9, 8, 7]), contentType: 'image/svg+xml' }
    const siteIcons = {
      getIconAsset: vi.fn(async () => asset),
      getExternalIconAsset: vi.fn(async () => null),
    } as unknown as SiteIconService
    const app = Fastify({ logger: false })
    resources.push(app)

    await registerAdminRoutes(app, {
      store: { getChannel: vi.fn(async () => channel) } as unknown as GatewayStore,
      agent: {} as OpsAgent,
      router: {} as GatewayRouter,
      adminAuth: { isValidToken: () => true } as unknown as AdminAuthService,
      gatewayBaseUrl: 'http://localhost:8080/v1',
      version: 'test',
      checkinDb: {
        listSites: () => [site],
        listChannelLinks: () => [{ siteId: site.id, channelId: channel.id, createdAt: '2026-08-06T00:00:00.000Z' }],
      } as unknown as AppDatabase,
      siteIcons,
    })

    const result = await app.inject({ method: 'GET', url: `/admin/channels/${channel.id}/favicon`, headers: { authorization: 'Bearer test-admin-token' } })

    expect(result.statusCode).toBe(200)
    expect(result.headers['content-type']).toContain('image/svg+xml')
    expect([...result.rawPayload]).toEqual([9, 8, 7])
    expect(siteIcons.getIconAsset).toHaveBeenCalledWith(site.id)
    expect(siteIcons.getExternalIconAsset).not.toHaveBeenCalled()
  })

  it('prefers a custom channel icon before the linked check-in site icon', async () => {
    const channel = {
      id: '00000000-0000-4000-8000-000000000003',
      baseUrl: 'https://relay.example/v1',
      faviconUrl: 'https://assets.example/custom-icon.png',
    } as Channel
    const asset = { body: new Uint8Array([4, 5, 6]), contentType: 'image/png' }
    const siteIcons = {
      getCustomIconAsset: vi.fn(async () => asset),
      getIconAsset: vi.fn(async () => null),
      getExternalIconAsset: vi.fn(async () => null),
    } as unknown as SiteIconService
    const app = Fastify({ logger: false })
    resources.push(app)

    await registerAdminRoutes(app, {
      store: { getChannel: vi.fn(async () => channel) } as unknown as GatewayStore,
      agent: {} as OpsAgent,
      router: {} as GatewayRouter,
      adminAuth: { isValidToken: () => true } as unknown as AdminAuthService,
      gatewayBaseUrl: 'http://localhost:8080/v1',
      version: 'test',
      checkinDb: {
        listSites: () => [{ id: 8, baseUrl: 'https://checkin.example' }],
        listChannelLinks: () => [{ siteId: 8, channelId: channel.id, createdAt: '2026-08-06T00:00:00.000Z' }],
      } as unknown as AppDatabase,
      siteIcons,
    })

    const result = await app.inject({ method: 'GET', url: `/admin/channels/${channel.id}/favicon`, headers: { authorization: 'Bearer test-admin-token' } })

    expect(result.statusCode).toBe(200)
    expect([...result.rawPayload]).toEqual([4, 5, 6])
    expect(siteIcons.getCustomIconAsset).toHaveBeenCalledWith(channel.faviconUrl, channel.baseUrl)
    expect(siteIcons.getIconAsset).not.toHaveBeenCalled()
    expect(siteIcons.getExternalIconAsset).not.toHaveBeenCalled()
  })

  it('accepts an SVG data URL as a custom channel icon', async () => {
    const channel = {
      id: '00000000-0000-4000-8000-000000000004',
      providerId: '00000000-0000-4000-8000-000000000002',
      providerName: 'Relay',
      name: 'Relay channel',
      baseUrl: 'https://relay.example/v1',
      faviconUrl: null,
      protocol: 'openai',
      keyCiphertext: 'ciphertext',
      keyName: 'API Key',
      keyLast4: '1234',
      status: 'healthy',
      enabled: true,
      priority: 0,
      weight: 100,
      minBalance: null,
      balance: null,
      balanceCurrency: null,
      balanceStatus: 'unknown',
      consecutiveFailures: 0,
      cooldownUntil: null,
      isolationReason: null,
      lastCheckedAt: null,
      lastLatencyMs: null,
      recentRequestCount: 0,
      recentErrorRate: 0,
      models: [],
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    } as Channel
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0EC8A9"/></svg>'
    const faviconUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
    const agent = {
      updateChannel: vi.fn(async (_id: string, input: Partial<Channel>) => ({ ...channel, ...input })),
    } as unknown as OpsAgent
    const app = Fastify({ logger: false })
    resources.push(app)

    await registerAdminRoutes(app, {
      store: { getChannel: vi.fn(async () => channel) } as unknown as GatewayStore,
      agent,
      router: {} as GatewayRouter,
      adminAuth: { isValidToken: () => true } as unknown as AdminAuthService,
      gatewayBaseUrl: 'http://localhost:8080/v1',
      version: 'test',
    })

    const result = await app.inject({
      method: 'PUT',
      url: `/admin/channels/${channel.id}`,
      headers: { authorization: 'Bearer test-admin-token' },
      payload: {
        name: 'Relay channel',
        baseUrl: 'https://relay.example/v1',
        faviconUrl,
        apiKey: '',
        protocol: 'openai',
        models: [],
        priority: 0,
        weight: 100,
        minBalance: null,
        tags: [],
        enabled: true,
      },
    })

    expect(result.statusCode).toBe(200)
    expect(agent.updateChannel).toHaveBeenCalledWith(channel.id, expect.objectContaining({ faviconUrl }))
  })
})
