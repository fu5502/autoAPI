import { parse } from 'node-html-parser'
import type { BrowserManager } from './browser-manager.js'
import { AppDatabase, type StoredIconAsset } from './db.js'

type Fetcher = typeof fetch

interface IconCandidate {
  url: string
  rel: string
  type: string
  sizes: string
  index: number
}

const htmlLimitBytes = 2 * 1024 * 1024
const iconLimitBytes = 2 * 1024 * 1024
const dataIconLimitBytes = 512 * 1024
const remoteIconUrlMaxLength = 2_000
const dataIconUrlPattern = /^data:(image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml))(?:;charset=[^;,]+)?;base64,([a-z0-9+/]*={0,2})$/i
const encodedSvgIconUrlPattern = /^data:image\/svg\+xml(?:;charset=[^;,]+)?,(.+)$/i
export const siteIconUrlMaxLength = Math.ceil(dataIconLimitBytes / 3) * 4 + 128
const persistentIconMaxAgeMs = 30 * 24 * 60 * 60 * 1000
const verifiedSiteIcons = new Map([
  ['anyrouter.top', '/logo.png'],
  ['token.dialoguedui.com', '/logo.png'],
])

export class SiteIconService {
  private readonly pending = new Map<number, Promise<string>>()
  private readonly assetCache = new Map<number, { url: string; asset: IconAsset | null }>()
  private readonly assetPending = new Map<number, { url: string; task: Promise<IconAsset | null> }>()
  private readonly renderedIconAttempts = new Set<number>()
  private readonly externalAssetCache = new Map<string, { asset: IconAsset | null; expiresAt: number }>()
  private readonly externalAssetPending = new Map<string, Promise<IconAsset | null>>()
  private readonly customAssetCache = new Map<string, { asset: IconAsset | null; expiresAt: number }>()
  private readonly customAssetPending = new Map<string, Promise<IconAsset | null>>()

  constructor(
    private readonly db: AppDatabase,
    private readonly fetcher: Fetcher = fetch,
    private readonly browser: BrowserManager | null = null,
  ) {}

  async getIconUrl(siteId: number, refresh = false): Promise<string | null> {
    const site = this.db.getSite(siteId)
    if (!site) throw new Error('站点不存在')
    if (!refresh) return site.faviconUrl
    if (refresh) {
      this.renderedIconAttempts.add(siteId)
      this.assetCache.delete(siteId)
      if (site.faviconCustom && site.faviconUrl) {
        this.db.touchSite(siteId)
        return site.faviconUrl
      }
    }

    const existing = this.pending.get(siteId)
    if (existing) return existing

    const task = this.resolveIconUrl(site.baseUrl, refresh)
      .then((faviconUrl) => {
        const updated = this.db.updateSiteFavicon(siteId, faviconUrl, site.baseUrl)
        return updated?.faviconUrl ?? faviconUrl
      })
      .finally(() => this.pending.delete(siteId))
    this.pending.set(siteId, task)
    return task
  }

  private async resolveIconUrl(baseUrl: string, forceRenderedPage = false): Promise<string> {
    const pageUrl = getIconPageUrl(baseUrl)
    const resolved = await resolveSiteIcon(baseUrl, this.fetcher)
    if (!this.browser || (!forceRenderedPage && !shouldInspectRenderedPage(pageUrl, resolved))) return resolved

    return this.browser.run({ interactive: false, closeBrowserWhenDone: true }, async (_context, page) => {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
      await page.waitForFunction(() => (
        document.querySelector("link[rel*='icon']")
        || Array.from(document.querySelectorAll<HTMLImageElement>('img')).some((image) => /logo|brand|徽标|标志/i.test(`${image.alt} ${image.id} ${image.className}`))
      ), undefined, { timeout: 5_000 }).catch(() => undefined)
      const rendered = await page.evaluate(() => ({
        candidates: Array.from(document.querySelectorAll<HTMLLinkElement>('link')).map((link, index) => ({
          url: link.href,
          rel: link.rel,
          type: link.type,
          sizes: link.getAttribute('sizes') || '',
          index,
        })),
        logo: Array.from(document.querySelectorAll<HTMLImageElement>('img'))
          .find((image) => /logo|brand|徽标|标志/i.test(`${image.alt} ${image.id} ${image.className}`))?.src ?? null,
      }))
      const candidate = rendered.candidates
        .filter((item) => /(?:^|\s)(?:icon|apple-touch-icon|mask-icon)(?:\s|$)/i.test(item.rel) && safeIconUrl(item.url, pageUrl) !== null)
        .sort((left, right) => scoreIconCandidate(right) - scoreIconCandidate(left))[0]
      return safeIconUrl(candidate?.url ?? rendered.logo, pageUrl) ?? resolved
    }).catch(() => resolved)
  }

  async getExternalIconAsset(baseUrl: string): Promise<IconAsset | null> {
    const cacheKey = `v1:external:${getIconPageUrl(baseUrl)}`
    const cached = this.externalAssetCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.asset

    const stored = this.readPersistentAsset(cacheKey)
    if (stored) {
      this.externalAssetCache.set(cacheKey, { asset: stored.asset, expiresAt: Date.now() + 10 * 60_000 })
      return stored.asset
    }

    const existing = this.externalAssetPending.get(cacheKey)
    if (existing) return existing

    const task = (async () => {
      const resolved = await this.resolveIconUrl(baseUrl, false)
      const direct = await this.loadIconAsset(baseUrl, resolved, true)
      if (direct) {
        this.savePersistentAsset(cacheKey, resolved, direct)
        return direct
      }

      const rendered = await this.resolveIconUrl(baseUrl, true)
      if (rendered === resolved) return null
      const asset = await this.loadIconAsset(baseUrl, rendered, true)
      if (asset) this.savePersistentAsset(cacheKey, rendered, asset)
      return asset
    })()
      .then((asset) => {
        this.externalAssetCache.set(cacheKey, {
          asset,
          expiresAt: Date.now() + (asset ? 10 * 60_000 : 60_000),
        })
        return asset
      })
      .finally(() => {
        if (this.externalAssetPending.get(cacheKey) === task) this.externalAssetPending.delete(cacheKey)
      })
    this.externalAssetPending.set(cacheKey, task)
    return task
  }

  async getCustomIconAsset(iconUrl: string, refererUrl: string): Promise<IconAsset | null> {
    let pageUrl: string
    let safeUrl: string | null
    try {
      pageUrl = getIconPageUrl(refererUrl)
      safeUrl = safeIconUrl(iconUrl, pageUrl)
    } catch {
      return null
    }
    if (!safeUrl) return null

    const cacheKey = `v1:custom:${pageUrl}|${safeUrl}`
    const cached = this.customAssetCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.asset

    const stored = this.readPersistentAsset(cacheKey)
    if (stored) {
      this.customAssetCache.set(cacheKey, { asset: stored.asset, expiresAt: Date.now() + 10 * 60_000 })
      return stored.asset
    }

    const existing = this.customAssetPending.get(cacheKey)
    if (existing) return existing

    const task = this.loadIconAsset(refererUrl, safeUrl, true)
      .then((asset) => {
        if (asset) this.savePersistentAsset(cacheKey, safeUrl, asset)
        this.customAssetCache.set(cacheKey, {
          asset,
          expiresAt: Date.now() + (asset ? 10 * 60_000 : 60_000),
        })
        return asset
      })
      .finally(() => {
        if (this.customAssetPending.get(cacheKey) === task) this.customAssetPending.delete(cacheKey)
      })
    this.customAssetPending.set(cacheKey, task)
    return task
  }

  private readPersistentAsset(cacheKey: string): { url: string; asset: IconAsset } | null {
    const database = this.db as AppDatabase & {
      getIconAssetCache?: (key: string) => StoredIconAsset | null
      clearIconAssetCache?: (key: string) => void
    }
    if (typeof database.getIconAssetCache !== 'function') return null
    let stored: StoredIconAsset | null
    try {
      stored = database.getIconAssetCache(cacheKey)
    } catch {
      return null
    }
    if (!stored) return null
    const updatedAt = Date.parse(stored.updatedAt)
    if (!Number.isFinite(updatedAt) || updatedAt < Date.now() - persistentIconMaxAgeMs) {
      try {
        database.clearIconAssetCache?.(cacheKey)
      } catch {
        // Cache cleanup is best-effort; an expired entry is still ignored.
      }
      return null
    }
    return {
      url: stored.url,
      asset: { body: stored.body, contentType: stored.contentType },
    }
  }

  private savePersistentAsset(cacheKey: string, url: string, asset: IconAsset): void {
    const database = this.db as AppDatabase & {
      saveIconAssetCache?: (key: string, value: { url: string; body: Uint8Array; contentType: string }) => void
    }
    try {
      database.saveIconAssetCache?.(cacheKey, { url, body: asset.body, contentType: asset.contentType })
    } catch {
      // Serving the fetched icon is more important than persisting its cache entry.
    }
  }

  async getIconAsset(siteId: number, refresh = false): Promise<IconAsset | null> {
    const site = this.db.getSite(siteId)
    if (!site) throw new Error('站点不存在')
    let url = await this.getIconUrl(siteId)
    if (!refresh && url) {
      const stored = this.db.getSiteIconAsset(siteId, url)
      if (stored) {
        const asset = { body: stored.body, contentType: stored.contentType }
        this.assetCache.set(siteId, { url, asset })
        return asset
      }
    }
    if (refresh || !url) {
      url = await this.getIconUrl(siteId, true)
    }
    if (!url) return null
    if (refresh) this.assetCache.delete(siteId)
    const cached = this.assetCache.get(siteId)
    if (cached?.url === url) return cached.asset

    const stored = this.db.getSiteIconAsset(siteId, url)
    if (!refresh && stored) {
      const asset = { body: stored.body, contentType: stored.contentType }
      this.assetCache.set(siteId, { url, asset })
      return asset
    }

    const existing = this.assetPending.get(siteId)
    if (existing?.url === url) return existing.task
    const task = this.loadIconAsset(site.baseUrl, url, true)
      .then((asset) => {
        const resolved = asset ?? (stored ? { body: stored.body, contentType: stored.contentType } : null)
        this.assetCache.set(siteId, { url, asset: resolved })
        if (asset) this.db.saveSiteIconAsset(siteId, { url, ...asset })
        return resolved
      })
      .finally(() => {
        if (this.assetPending.get(siteId)?.task === task) this.assetPending.delete(siteId)
      })
    this.assetPending.set(siteId, { url, task })
    return task
  }

  forgetSite(siteId: number): void {
    this.pending.delete(siteId)
    this.assetCache.delete(siteId)
    this.assetPending.delete(siteId)
    this.renderedIconAttempts.delete(siteId)
  }

  private async loadIconAsset(baseUrl: string, iconUrl: string, allowBrowser: boolean): Promise<IconAsset | null> {
    const direct = await fetchIconAsset(iconUrl, baseUrl, this.fetcher)
    if (direct || !allowBrowser || !this.browser) return direct

    return this.browser.run({ interactive: false, closeBrowserWhenDone: true }, async (context) => {
      const response = await context.request.get(iconUrl, {
        timeout: 15_000,
        headers: { Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8', Referer: getIconPageUrl(baseUrl) },
      })
      if (!response.ok()) return null
      const body = await response.body()
      const contentType = response.headers()['content-type'] || inferIconContentType(iconUrl)
      return isSafeIconAsset(contentType, body.byteLength) ? { body, contentType } : null
    }).catch(() => null)
  }
}

export interface IconAsset {
  body: Uint8Array
  contentType: string
}

/** Decode the supported data-URL image form without sending user data to a remote URL. */
export function parseImageDataUrl(value: string): IconAsset | null {
  const trimmed = value.trim()
  const match = dataIconUrlPattern.exec(trimmed)
  if (match) {
    const contentType = match[1]
    const encoded = match[2]
    if (!contentType || !encoded || encoded.length % 4 === 1) return null
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const estimatedSize = Math.floor(encoded.length * 3 / 4) - padding
    if (estimatedSize <= 0 || estimatedSize > dataIconLimitBytes) return null
    const body = Buffer.from(encoded, 'base64')
    if (body.byteLength !== estimatedSize || !isSafeIconAsset(contentType, body.byteLength)) return null
    return { body, contentType: contentType.toLowerCase() }
  }

  const svgMatch = encodedSvgIconUrlPattern.exec(trimmed)
  if (!svgMatch || !svgMatch[1]) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(svgMatch[1])
  } catch {
    return null
  }
  const body = Buffer.from(decoded, 'utf8')
  if (body.byteLength <= 0 || body.byteLength > dataIconLimitBytes || !isSafeIconAsset('image/svg+xml', body.byteLength)) return null
  return { body, contentType: 'image/svg+xml' }
}

export function isAllowedIconUrl(value: string): boolean {
  if (parseImageDataUrl(value)) return true
  if (value.length > remoteIconUrlMaxLength) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export async function resolveSiteIcon(baseUrl: string, fetcher: Fetcher = fetch): Promise<string> {
  const base = new URL(baseUrl)
  const pageUrl = getIconPageUrl(baseUrl)
  const verifiedPath = verifiedSiteIcons.get(base.hostname.toLowerCase())
  const fallback = new URL(verifiedPath ?? 'favicon.ico', pageUrl).toString()
  try {
    const response = await fetcher(pageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      },
    })
    if (!response.ok) return fallback
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > htmlLimitBytes) return fallback
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/html|xhtml/i.test(contentType)) return fallback

    const html = (await response.text()).slice(0, htmlLimitBytes)
    const document = parse(html)
    const candidates = document.querySelectorAll('link')
      .map((link, index) => {
        const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/)
        const href = link.getAttribute('href')
        if (!href || (!rel.includes('icon') && !rel.includes('apple-touch-icon'))) return null
        try {
          const url = new URL(href, response.url || pageUrl)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
          const sizes = link.getAttribute('sizes') || ''
          return {
            url: url.toString(),
            rel: rel.join(' '),
            type: link.getAttribute('type') || '',
            sizes,
            index,
          } satisfies IconCandidate
        } catch {
          return null
        }
      })
      .filter((candidate): candidate is IconCandidate => candidate !== null)
      .sort((left, right) => scoreIconCandidate(right) - scoreIconCandidate(left))

    if (candidates[0]) return candidates[0].url

    const pageLogo = document.querySelectorAll('img')
      .find((image) => /logo|brand|徽标|标志/i.test(`${image.getAttribute('alt') || ''} ${image.getAttribute('id') || ''} ${image.getAttribute('class') || ''}`))
    return safeIconUrl(pageLogo?.getAttribute('src') ?? null, response.url || pageUrl) ?? fallback
  } catch {
    return fallback
  }
}

export function getIconPageUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const segments = url.pathname.split('/').filter(Boolean)
  const versionIndex = segments.findIndex((segment) => /^v\d+(?:beta)?$/i.test(segment))
  const pageSegments = versionIndex >= 0 ? segments.slice(0, versionIndex) : segments
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = pageSegments.length ? `/${pageSegments.join('/')}/` : '/'
  return url.toString()
}

function isFallbackIconUrl(iconUrl: string, baseUrl: string): boolean {
  try {
    const icon = new URL(iconUrl)
    const fallback = new URL('favicon.ico', getIconPageUrl(baseUrl))
    return icon.origin === fallback.origin && icon.pathname === fallback.pathname
  } catch {
    return false
  }
}

function scoreIconCandidate(candidate: IconCandidate): number {
  const rel = candidate.rel.toLowerCase().split(/\s+/)
  const iconScore = rel.includes('icon') ? 220 : rel.includes('apple-touch-icon') ? 120 : rel.includes('mask-icon') ? 90 : 0
  const typeScore = /svg/i.test(candidate.type) || /\.svg(?:$|\?)/i.test(candidate.url) ? 12 : 0
  const largestSize = Math.max(0, ...[...candidate.sizes.matchAll(/\d+/g)].map((match) => Number(match[0])))
  return iconScore + typeScore + Math.min(largestSize, 512) / 100 - candidate.index / 1000
}

function shouldInspectRenderedPage(baseUrl: string, resolvedUrl: string): boolean {
  const base = new URL(baseUrl)
  if (base.hostname.toLowerCase() === 'token.dialoguedui.com') return true
  return resolvedUrl === new URL('favicon.ico', getIconPageUrl(baseUrl)).toString()
}

function safeIconUrl(candidate: string | null, baseUrl: string): string | null {
  if (!candidate) return null
  if (parseImageDataUrl(candidate)) return candidate.trim()
  try {
    const url = new URL(candidate, baseUrl)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

async function fetchIconAsset(iconUrl: string, baseUrl: string, fetcher: Fetcher): Promise<IconAsset | null> {
  const dataAsset = parseImageDataUrl(iconUrl)
  if (dataAsset) return dataAsset
  try {
    const response = await fetcher(iconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8',
        Referer: getIconPageUrl(baseUrl),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      },
    })
    if (!response.ok) return null
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > iconLimitBytes) return null
    const contentType = response.headers.get('content-type') || inferIconContentType(iconUrl)
    if (!isSafeIconAsset(contentType, contentLength)) return null
    const body = new Uint8Array(await response.arrayBuffer())
    return isSafeIconAsset(contentType, body.byteLength) ? { body, contentType } : null
  } catch {
    return null
  }
}

function isSafeIconAsset(contentType: string, size: number): boolean {
  return size >= 0 && size <= iconLimitBytes && /^(?:image\/|application\/svg\+xml)/i.test(contentType)
}

function inferIconContentType(iconUrl: string): string {
  const pathname = new URL(iconUrl).pathname.toLowerCase()
  if (pathname.endsWith('.svg')) return 'image/svg+xml'
  if (pathname.endsWith('.webp')) return 'image/webp'
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
  if (pathname.endsWith('.gif')) return 'image/gif'
  if (pathname.endsWith('.ico')) return 'image/x-icon'
  return 'image/png'
}
