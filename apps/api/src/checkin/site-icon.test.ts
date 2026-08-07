import { describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './db.js'
import { getIconPageUrl, resolveSiteIcon, SiteIconService } from './site-icon.js'

function response(body: BodyInit | null, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('site icon resolution', () => {
  it('maps an API base URL to the site page and prefers the regular icon', async () => {
    const requests: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://relay.example/') {
        return response(
          '<link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><link rel="icon" type="image/svg+xml" href="/brand.svg">',
          'text/html',
        )
      }
      return response('<svg></svg>', 'image/svg+xml')
    }) as unknown as typeof fetch

    expect(getIconPageUrl('https://relay.example/v1/chat/completions')).toBe('https://relay.example/')
    expect(getIconPageUrl('https://relay.example/gateway/v1')).toBe('https://relay.example/gateway/')
    await expect(resolveSiteIcon('https://relay.example/v1', fetcher)).resolves.toBe('https://relay.example/brand.svg')
    expect(requests[0]).toBe('https://relay.example/')
  })

  it('proxies and deduplicates an ordinary channel icon without a check-in site', async () => {
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://relay.example/') {
        return response('<link rel="icon" href="/brand.png">', 'text/html')
      }
      return response(new Uint8Array([1, 2, 3]), 'image/png')
    })
    const fetcher = fetcherMock as unknown as typeof fetch
    const service = new SiteIconService({} as AppDatabase, fetcher)

    const [first, second] = await Promise.all([
      service.getExternalIconAsset('https://relay.example/v1'),
      service.getExternalIconAsset('https://relay.example/v1'),
    ])

    expect(first).toMatchObject({ contentType: 'image/png' })
    expect(second).toMatchObject({ contentType: 'image/png' })
    expect(fetcherMock).toHaveBeenCalledTimes(2)
    expect(fetcherMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://relay.example/',
      'https://relay.example/brand.png',
    ])
  })

  it('reuses a persisted external icon after the service is recreated', async () => {
    const records = new Map<string, { url: string; body: Uint8Array; contentType: string; updatedAt: string }>()
    const database = {
      getIconAssetCache: vi.fn((key: string) => records.get(key) ?? null),
      saveIconAssetCache: vi.fn((key: string, asset: { url: string; body: Uint8Array; contentType: string }) => {
        records.set(key, { ...asset, updatedAt: new Date().toISOString() })
      }),
      clearIconAssetCache: vi.fn(),
    } as unknown as AppDatabase
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://relay.example/') return response('<link rel="icon" href="/brand.png">', 'text/html')
      return response(new Uint8Array([4, 5, 6]), 'image/png')
    })
    const fetcher = fetcherMock as unknown as typeof fetch

    await new SiteIconService(database, fetcher).getExternalIconAsset('https://relay.example/v1')
    const second = await new SiteIconService(database, fetcher).getExternalIconAsset('https://relay.example/v1')

    expect(second).toMatchObject({ contentType: 'image/png' })
    expect(fetcherMock).toHaveBeenCalledTimes(2)
    expect(database.saveIconAssetCache).toHaveBeenCalledTimes(1)
  })

  it('reuses a persisted check-in site icon without resolving the site again', async () => {
    const site = {
      id: 11,
      baseUrl: 'https://relay.example/v1',
      faviconUrl: null as string | null,
      faviconCustom: false,
    }
    const storedAssets = new Map<string, { url: string; body: Uint8Array; contentType: string }>()
    const database = {
      getSite: vi.fn(() => site),
      updateSiteFavicon: vi.fn((_siteId: number, url: string) => {
        site.faviconUrl = url
        return site
      }),
      getSiteIconAsset: vi.fn((_siteId: number, url: string) => storedAssets.get(url) ?? null),
      saveSiteIconAsset: vi.fn((_siteId: number, asset: { url: string; body: Uint8Array; contentType: string }) => {
        storedAssets.set(asset.url, asset)
      }),
    } as unknown as AppDatabase
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://relay.example/') return response('<link rel="icon" href="/brand.png">', 'text/html')
      return response(new Uint8Array([9, 8, 7]), 'image/png')
    })
    const fetcher = fetcherMock as unknown as typeof fetch

    await expect(new SiteIconService(database, fetcher).getIconAsset(site.id)).resolves.toMatchObject({ contentType: 'image/png' })
    await expect(new SiteIconService(database, fetcher).getIconAsset(site.id)).resolves.toMatchObject({ contentType: 'image/png' })

    expect(fetcherMock).toHaveBeenCalledTimes(2)
    expect(database.saveSiteIconAsset).toHaveBeenCalledTimes(1)
  })

  it('loads a custom icon directly and rejects credential-bearing addresses', async () => {
    const fetcherMock = vi.fn(async (_input: RequestInfo | URL) => response(new Uint8Array([7, 8, 9]), 'image/png'))
    const service = new SiteIconService({} as AppDatabase, fetcherMock as unknown as typeof fetch)

    await expect(service.getCustomIconAsset('https://assets.example/brand.png', 'https://relay.example/v1')).resolves.toMatchObject({ contentType: 'image/png' })
    await expect(service.getCustomIconAsset('https://user:password@assets.example/brand.png', 'https://relay.example/v1')).resolves.toBeNull()
    expect(fetcherMock).toHaveBeenCalledTimes(1)
    expect(String(fetcherMock.mock.calls[0]?.[0])).toBe('https://assets.example/brand.png')
  })
})
