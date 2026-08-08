import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpsAgent } from '../agent/ops-agent.js'
import { AppDatabase } from './db.js'
import { registerCheckinRoutes, type CheckinModule } from './module.js'
import { SiteIconService } from './site-icon.js'

const databases: AppDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
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
})
