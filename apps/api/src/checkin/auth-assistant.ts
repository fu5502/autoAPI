import { createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { BrowserContext } from 'playwright-core'
import type { SecretBox } from '../security/secret-box.js'
import type { AppDatabase } from './db.js'
import type { EventBus } from './events.js'
import type { Site } from './types.js'
import { officialNameForAuth } from './site-name.js'
import { nowIso } from './utils.js'

const PAIR_TTL_MS = 10 * 60_000
const MAX_COOKIES = 1_000
const MAX_STORAGE_ITEMS = 2_000
const MAX_STORAGE_VALUE_LENGTH = 256 * 1024
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expires?: number
}

export interface BrowserAuthSnapshot {
  siteOrigin: string
  cookies: BrowserCookie[]
  localStorageByHost: Record<string, Record<string, string>>
  updatedAt: string
}

export interface AuthAssistantPairingInfo {
  pairId: string
  code: string
  siteId: number
  siteName: string
  domain: string
  siteUrl: string
  adapter: Site['adapter']
  expiresAt: string
  uploadPath: '/auth-assistant/upload'
  claimPath: '/auth-assistant/claim'
}

export interface AuthAssistantUploadInput {
  pairId: string
  uploadToken: string
  iv: string
  ciphertext: string
}

export interface AuthAssistantFailureInput {
  pairId: string
  uploadToken: string
  message: string
}

export interface AuthAssistantPairingStatus {
  pairId: string
  siteId: number
  status: 'waiting' | 'claimed' | 'received' | 'failed' | 'expired' | 'cancelled'
  code: string
  domain: string
  expiresAt: string
  claimedAt: string | null
  receivedAt: string | null
  cookieCount: number
  localStorageCount: number
  message: string
}

interface Pairing extends AuthAssistantPairingInfo {
  secret: Buffer
  uploadToken: string
  status: AuthAssistantPairingStatus['status']
  claimedAt: string | null
  receivedAt: string | null
  cookieCount: number
  localStorageCount: number
  message: string
  authEventId: number
}

interface AssistantUploadPayload {
  siteOrigin?: unknown
  pageTitle?: unknown
  cookies?: unknown
  localStorage?: unknown
  sentAt?: unknown
}

export class AuthAssistantService {
  private readonly pairings = new Map<string, Pairing>()

  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretBox | null,
    private readonly events: EventBus,
  ) {
    // Pairings live in memory, so an interrupted process cannot complete them.
    // Mark the corresponding persisted records before exposing the new service.
    this.db.recoverPendingAuthSyncs()
  }

  createPair(site: Site): AuthAssistantPairingInfo {
    this.cleanup()
    for (const pairing of this.pairings.values()) {
      if (pairing.siteId === site.id && ['waiting', 'claimed'].includes(pairing.status)) {
        pairing.status = 'cancelled'
        pairing.message = '新的授权任务已生成'
        this.db.completeAuthSync(pairing.authEventId, 'cancelled', pairing.message, 0, 0)
        this.clearPairSecrets(pairing)
      }
    }

    const domain = new URL(site.baseUrl).hostname.toLowerCase()
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString()
    const authEventId = this.db.startAuthSync(site.id, 'assistant', '等待本地授权助手同步')
    const pairing: Pairing = {
      pairId: id,
      code: createPairCode(),
      siteId: site.id,
      siteName: site.name,
      domain,
      siteUrl: site.baseUrl,
      adapter: site.adapter,
      expiresAt,
      uploadPath: '/auth-assistant/upload',
      claimPath: '/auth-assistant/claim',
      secret: randomBytes(32),
      uploadToken: randomBytes(32).toString('base64url'),
      status: 'waiting',
      claimedAt: null,
      receivedAt: null,
      cookieCount: 0,
      localStorageCount: 0,
      message: '请在本地 autoAPI 授权助手中输入授权码',
      authEventId,
    }
    this.pairings.set(id, pairing)
    return this.toInfo(pairing)
  }

  getPairStatus(pairId: string, siteId: number): AuthAssistantPairingStatus | null {
    this.cleanup()
    const pairing = this.pairings.get(pairId)
    if (!pairing || pairing.siteId !== siteId) return null
    return this.toStatus(pairing)
  }

  preview(code: string): AuthAssistantPairingInfo {
    this.cleanup()
    const normalized = code.trim().toUpperCase()
    const pairing = [...this.pairings.values()].find((item) => item.code === normalized)
    if (!pairing) throw new Error('授权码不存在或已过期')
    if (pairing.status !== 'waiting' && pairing.status !== 'claimed') throw new Error('授权任务已结束，请在后台重新生成授权码')
    return this.toInfo(pairing)
  }

  cancelPair(pairId: string, siteId: number): AuthAssistantPairingStatus | null {
    const pairing = this.pairings.get(pairId)
    if (!pairing || pairing.siteId !== siteId) return null
    if (['waiting', 'claimed'].includes(pairing.status)) {
      pairing.status = 'cancelled'
      pairing.message = '本次本地授权已取消'
      this.db.completeAuthSync(pairing.authEventId, 'cancelled', pairing.message, 0, 0)
      this.clearPairSecrets(pairing)
    }
    return this.toStatus(pairing)
  }

  cancelPairsForSite(siteId: number): void {
    for (const pairing of this.pairings.values()) {
      if (pairing.siteId !== siteId || !['waiting', 'claimed'].includes(pairing.status)) continue
      pairing.status = 'cancelled'
      pairing.message = '关联站点已删除，授权任务已取消'
      this.db.completeAuthSync(pairing.authEventId, 'cancelled', pairing.message, 0, 0)
      this.clearPairSecrets(pairing)
    }
  }

  claim(code: string, currentHostname?: string): { pairId: string; siteId: number; siteName: string; domain: string; secret: string; uploadToken: string; expiresAt: string } {
    this.cleanup()
    const normalized = code.trim().toUpperCase()
    const pairing = [...this.pairings.values()].find((item) => item.code === normalized)
    if (!pairing) throw new Error('授权码不存在或已过期')
    if (pairing.status !== 'waiting') throw new Error('授权任务已结束，请在后台重新生成授权码')
    if (currentHostname !== undefined) {
      const normalizedHostname = normalizeHostname(currentHostname)
      if (!normalizedHostname || !isAllowedHost(normalizedHostname, pairing.domain)) {
        throw new Error(`当前站点 ${currentHostname} 与目标站点 ${pairing.domain} 不匹配`)
      }
    }
    pairing.claimedAt = nowIso()
    pairing.status = 'claimed'
    pairing.message = '授权助手已连接，等待上传当前站点登录状态'
    this.db.markAuthSyncClaimed(pairing.authEventId, pairing.message)
    return {
      pairId: pairing.pairId,
      siteId: pairing.siteId,
      siteName: pairing.siteName,
      domain: pairing.domain,
      secret: pairing.secret.toString('base64url'),
      uploadToken: pairing.uploadToken,
      expiresAt: pairing.expiresAt,
    }
  }

  acceptUpload(input: AuthAssistantUploadInput): AuthAssistantPairingStatus {
    this.cleanup()
    const pairing = this.pairings.get(input.pairId)
    if (!pairing) throw new Error('授权任务不存在或已过期')
    if (pairing.status !== 'claimed') throw new Error('授权任务已结束或尚未连接，请重新生成授权码')
    if (!secureEqual(pairing.uploadToken, input.uploadToken)) throw new Error('授权助手上传 Token 不正确')
    if (!this.secrets) throw new Error('服务器尚未配置会话加密密钥')
    try {
      const payload = decryptPayload(input, pairing.secret)
      const site = this.db.getSite(pairing.siteId)
      if (!site) throw new Error('签到站点不存在')
      const snapshot = normalizeSnapshot(payload, site.baseUrl, pairing.domain)
      const pageTitle = normalizePageTitle(payload.pageTitle)
      if (!snapshot.cookies.length && !Object.keys(snapshot.localStorageByHost).length) {
        throw new Error('当前页面没有读取到 Cookie 或 Local Storage，请先登录目标签到站点')
      }
      const resolvedName = officialNameForAuth(site, pageTitle)
      const serializedSnapshot = JSON.stringify(snapshot)
      if (Buffer.byteLength(serializedSnapshot, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new Error('授权助手登录状态超过 8 MB 限制，请减少站点存储后重试')
      }
      this.db.saveSiteAuthSnapshot(pairing.siteId, this.secrets.encrypt(serializedSnapshot))
      this.db.updateSiteAuth(pairing.siteId, {
        adapter: site.adapter,
        authStatus: 'valid',
        ...(resolvedName !== site.name ? { name: resolvedName } : {}),
        lastError: null,
      })
      pairing.status = 'received'
      pairing.receivedAt = nowIso()
      pairing.cookieCount = snapshot.cookies.length
      pairing.localStorageCount = Object.values(snapshot.localStorageByHost).reduce((total, values) => total + Object.keys(values).length, 0)
      pairing.message = '本地登录状态已同步，下一次签到会使用该会话'
      this.db.completeAuthSync(pairing.authEventId, 'success', pairing.message, pairing.cookieCount, pairing.localStorageCount)
      this.events.emit({
        type: 'auth_changed',
        title: '本地授权同步成功',
        message: `${pageTitle ?? site.name} 已接收 autoAPI 授权助手登录状态`,
        data: { siteId: site.id, method: 'assistant', pageTitle: pageTitle ?? site.name, cookieCount: pairing.cookieCount, localStorageCount: pairing.localStorageCount },
      })
      const status = this.toStatus(pairing)
      this.clearPairSecrets(pairing)
      return status
    } catch (error) {
      const message = error instanceof Error ? error.message : '授权助手上传失败'
      pairing.status = 'failed'
      pairing.message = message
      this.db.completeAuthSync(pairing.authEventId, 'failed', message, 0, 0)
      this.clearPairSecrets(pairing)
      throw error
    }
  }

  failPair(input: AuthAssistantFailureInput): AuthAssistantPairingStatus {
    this.cleanup()
    const pairing = this.pairings.get(input.pairId)
    if (!pairing) throw new Error('授权任务不存在或已过期')
    if (pairing.status !== 'claimed') throw new Error('授权任务已结束或尚未连接，请重新生成授权码')
    if (!secureEqual(pairing.uploadToken, input.uploadToken)) throw new Error('授权助手上传 Token 不正确')
    const message = input.message.trim().slice(0, 500) || '本地授权助手未能读取当前站点状态'
    pairing.status = 'failed'
    pairing.message = message
    this.db.completeAuthSync(pairing.authEventId, 'failed', message, 0, 0)
    this.clearPairSecrets(pairing)
    this.events.emit({
      type: 'auth_changed',
      title: '本地授权同步失败',
      message,
      data: { siteId: pairing.siteId, method: 'assistant' },
    })
    return this.toStatus(pairing)
  }

  async applyToContext(context: BrowserContext, siteId: number): Promise<BrowserAuthSnapshot | null> {
    const snapshot = await this.getSnapshot(siteId)
    if (!snapshot) return null
    try {
      if (snapshot.cookies.length) await context.addCookies(snapshot.cookies)
      return snapshot
    } catch {
      return null
    }
  }

  async getSnapshot(siteId: number): Promise<BrowserAuthSnapshot | null> {
    if (!this.secrets) return null
    const stored = this.db.getSiteAuthSnapshot(siteId)
    if (!stored) return null
    try {
      const snapshot = JSON.parse(this.secrets.decrypt(stored.encrypted)) as BrowserAuthSnapshot
      if (!snapshot || !Array.isArray(snapshot.cookies) || !snapshot.localStorageByHost) return null
      if (!snapshot.siteOrigin || typeof snapshot.siteOrigin !== 'string' || !isRecord(snapshot.localStorageByHost)) return null
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) return null
      return snapshot
    } catch {
      return null
    }
  }

  updateSnapshotLocalStorage(siteId: number, host: string, values: Record<string, string>): boolean {
    if (!this.secrets || !values) return false
    const stored = this.db.getSiteAuthSnapshot(siteId)
    if (!stored) return false
    try {
      const snapshot = JSON.parse(this.secrets.decrypt(stored.encrypted)) as BrowserAuthSnapshot
      if (!snapshot || !isRecord(snapshot.localStorageByHost)) return false
      const normalizedHost = host.toLowerCase().replace(/\.$/, '')
      const items = snapshot.localStorageByHost[normalizedHost] ??= {}
      let changed = false
      for (const [key, value] of Object.entries(values)) {
        if (!key || key.length > 512 || typeof value !== 'string' || value.length > MAX_STORAGE_VALUE_LENGTH) continue
        if (items[key] !== value) {
          items[key] = value
          changed = true
        }
      }
      if (!changed) return false
      snapshot.updatedAt = nowIso()
      const serialized = JSON.stringify(snapshot)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) return false
      this.db.saveSiteAuthSnapshot(siteId, this.secrets.encrypt(serialized))
      return true
    } catch {
      return false
    }
  }

  close(): void {
    for (const pairing of this.pairings.values()) {
      if (['waiting', 'claimed'].includes(pairing.status)) {
        this.db.completeAuthSync(pairing.authEventId, 'cancelled', '服务已关闭，授权任务已取消', 0, 0)
      }
      this.clearPairSecrets(pairing)
    }
    this.pairings.clear()
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, pairing] of this.pairings) {
      if (Date.parse(pairing.expiresAt) <= now && ['waiting', 'claimed'].includes(pairing.status)) {
        pairing.status = 'expired'
        pairing.message = '授权码已过期，请重新生成'
        this.db.completeAuthSync(pairing.authEventId, 'failed', pairing.message, 0, 0)
        this.clearPairSecrets(pairing)
      }
      if (!['waiting', 'claimed'].includes(pairing.status) && Date.parse(pairing.expiresAt) + PAIR_TTL_MS <= now) this.pairings.delete(id)
    }
  }

  private toInfo(pairing: Pairing): AuthAssistantPairingInfo {
    return {
      pairId: pairing.pairId,
      code: pairing.code,
      siteId: pairing.siteId,
      siteName: pairing.siteName,
      domain: pairing.domain,
      siteUrl: pairing.siteUrl,
      adapter: pairing.adapter,
      expiresAt: pairing.expiresAt,
      uploadPath: pairing.uploadPath,
      claimPath: pairing.claimPath,
    }
  }

  private toStatus(pairing: Pairing): AuthAssistantPairingStatus {
    return {
      pairId: pairing.pairId,
      siteId: pairing.siteId,
      status: pairing.status,
      code: pairing.code,
      domain: pairing.domain,
      expiresAt: pairing.expiresAt,
      claimedAt: pairing.claimedAt,
      receivedAt: pairing.receivedAt,
      cookieCount: pairing.cookieCount,
      localStorageCount: pairing.localStorageCount,
      message: pairing.message,
    }
  }

  private clearPairSecrets(pairing: Pairing): void {
    pairing.secret.fill(0)
    pairing.uploadToken = ''
  }
}

function createPairCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(12)
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('')
}

function decryptPayload(input: AuthAssistantUploadInput, secret: Buffer): AssistantUploadPayload {
  const iv = Buffer.from(input.iv, 'base64url')
  const encrypted = Buffer.from(input.ciphertext, 'base64url')
  if (iv.length !== 12 || encrypted.length < 17 || encrypted.length > 8 * 1024 * 1024) throw new Error('授权助手加密数据无效或过大')
  const decipher = createDecipheriv('aes-256-gcm', secret, iv)
  decipher.setAuthTag(encrypted.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()])
  const payload = JSON.parse(plaintext.toString('utf8')) as AssistantUploadPayload
  if (!payload || typeof payload !== 'object') throw new Error('授权助手数据格式无效')
  return payload
}

function normalizeSnapshot(payload: AssistantUploadPayload, baseUrl: string, allowedHost?: string): BrowserAuthSnapshot {
  const siteUrl = new URL(baseUrl)
  const siteHost = siteUrl.hostname.toLowerCase()
  const origin = parseSiteOrigin(payload.siteOrigin)
  const originHost = origin.hostname.toLowerCase()
  const expectedHost = normalizeHostname(allowedHost ?? siteHost)
  if (!expectedHost || !isAllowedHost(originHost, expectedHost) || !sameProtocolAndPort(siteUrl, origin)) {
    throw new Error('当前浏览器页面不是目标签到站点')
  }
  const expectedOrigin = origin.origin
  const cookies: BrowserCookie[] = []
  const seenCookies = new Set<string>()
  if (Array.isArray(payload.cookies)) {
    if (payload.cookies.length > MAX_COOKIES) throw new Error(`授权助手上传的 Cookie 数量超过上限（${MAX_COOKIES}）`)
    for (const value of payload.cookies) {
      const cookie = normalizeCookie(value, siteHost)
      if (!cookie) continue
      const identity = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
      if (seenCookies.has(identity)) continue
      seenCookies.add(identity)
      cookies.push(cookie)
    }
  }
  const localStorageByHost: Record<string, Record<string, string>> = {}
  if (isRecord(payload.localStorage)) {
    const items: Record<string, string> = {}
    for (const [key, value] of Object.entries(payload.localStorage)) {
      if (!key || typeof value !== 'string') continue
      if (key.length > 512 || value.length > MAX_STORAGE_VALUE_LENGTH) continue
      if (Object.keys(items).length >= MAX_STORAGE_ITEMS) break
      items[key] = value
    }
    if (Object.keys(items).length) localStorageByHost[originHost] = items
  }
  return { siteOrigin: expectedOrigin, cookies, localStorageByHost, updatedAt: nowIso() }
}

function normalizePageTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return normalized || null
}

function parseSiteOrigin(value: unknown): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error('当前浏览器页面不是目标签到站点')
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('当前浏览器页面不是目标签到站点')
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || value !== origin.origin) {
    throw new Error('当前浏览器页面不是目标签到站点')
  }
  return origin
}

function sameProtocolAndPort(siteUrl: URL, origin: URL): boolean {
  if (siteUrl.protocol !== origin.protocol) return false
  return effectivePort(siteUrl) === effectivePort(origin)
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

function normalizeCookie(value: unknown, siteHost: string): BrowserCookie | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name : ''
  const cookieValue = typeof value.value === 'string' ? value.value : ''
  const rawDomain = typeof value.domain === 'string' ? value.domain.trim().toLowerCase() : siteHost
  const domain = rawDomain.replace(/^\.+/, '')
  if (!name || !isAllowedHost(domain, siteHost)) return null
  const sameSite = normalizeSameSite(value.sameSite)
  const expiration = typeof value.expirationDate === 'number' ? value.expirationDate : undefined
  return {
    name,
    value: cookieValue,
    domain: rawDomain.startsWith('.') ? rawDomain : domain,
    path: typeof value.path === 'string' && value.path.startsWith('/') ? value.path : '/',
    secure: Boolean(value.secure),
    httpOnly: Boolean(value.httpOnly),
    ...(sameSite ? { sameSite } : {}),
    ...(expiration && Number.isFinite(expiration) && expiration > Math.floor(Date.now() / 1000) ? { expires: Math.floor(expiration) } : {}),
  }
}

function normalizeHostname(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

function normalizeSameSite(value: unknown): BrowserCookie['sameSite'] | undefined {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'None'
  return undefined
}

function isAllowedHost(host: string, siteHost: string): boolean {
  if (host === siteHost || host.endsWith(`.${siteHost}`)) return true
  if (!siteHost.endsWith(`.${host}`)) return false
  const hostLabels = host.split('.').filter(Boolean)
  const siteLabels = siteHost.split('.').filter(Boolean)
  return hostLabels.length >= 2 && siteLabels.length - hostLabels.length <= 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
