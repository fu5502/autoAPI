import { createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BrowserContext } from 'playwright-core'
import type { SecretBox } from '../security/secret-box.js'
import type { AppDatabase } from './db.js'
import type { EventBus } from './events.js'
import type { Site } from './types.js'
import { nowIso } from './utils.js'

const PAIR_TTL_MS = 15 * 60_000

export type CookieCloudCryptoType = 'legacy' | 'aes-128-cbc-fixed'

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

interface CookieCloudPayload {
  cookie_data?: unknown
  local_storage_data?: unknown
  update_time?: unknown
}

interface Pairing {
  id: string
  siteId: number
  uuid: string
  password: string
  uploadToken: string
  createdAt: string
  expiresAt: string
  status: 'waiting' | 'received' | 'failed' | 'expired' | 'cancelled'
  cryptoType: CookieCloudCryptoType
  receivedAt: string | null
  cookieCount: number
  localStorageCount: number
  message: string
}

export interface CookieCloudPairingInfo {
  pairId: string
  uuid: string
  password: string
  uploadToken: string
  headerName: 'X-AutoAPI-Pairing-Token'
  domain: string
  expiresAt: string
}

export interface CookieCloudPairingStatus {
  pairId: string
  siteId: number
  status: Pairing['status']
  expiresAt: string
  receivedAt: string | null
  cookieCount: number
  localStorageCount: number
  message: string
}

export class CookieCloudService {
  private readonly pairings = new Map<string, Pairing>()

  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretBox | null,
    private readonly events: EventBus,
  ) {}

  createPair(site: Site): CookieCloudPairingInfo {
    this.cleanup()
    for (const pairing of this.pairings.values()) {
      if (pairing.siteId === site.id && pairing.status === 'waiting') pairing.status = 'cancelled'
    }

    const id = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString()
    const pairing: Pairing = {
      id,
      siteId: site.id,
      uuid: crypto.randomUUID(),
      password: randomBytes(24).toString('base64url'),
      uploadToken: randomBytes(32).toString('base64url'),
      createdAt: nowIso(),
      expiresAt,
      status: 'waiting',
      cryptoType: 'legacy',
      receivedAt: null,
      cookieCount: 0,
      localStorageCount: 0,
      message: '请在本地 CookieCloud 插件中完成上传',
    }
    this.pairings.set(id, pairing)

    return {
      pairId: pairing.id,
      uuid: pairing.uuid,
      password: pairing.password,
      uploadToken: pairing.uploadToken,
      headerName: 'X-AutoAPI-Pairing-Token',
      domain: new URL(site.baseUrl).hostname,
      expiresAt,
    }
  }

  getPairStatus(pairId: string, siteId: number): CookieCloudPairingStatus | null {
    this.cleanup()
    const pairing = this.pairings.get(pairId)
    if (!pairing || pairing.siteId !== siteId) return null
    return this.toStatus(pairing)
  }

  cancelPair(pairId: string, siteId: number): CookieCloudPairingStatus | null {
    const pairing = this.pairings.get(pairId)
    if (!pairing || pairing.siteId !== siteId) return null
    if (pairing.status === 'waiting') {
      pairing.status = 'cancelled'
      pairing.message = '本次本地授权已取消'
    }
    return this.toStatus(pairing)
  }

  acceptUpload(uuid: string, encrypted: string, uploadToken: string, cryptoType: CookieCloudCryptoType = 'legacy') {
    this.cleanup()
    const pairing = [...this.pairings.values()].find((item) => item.uuid === uuid)
    if (!pairing) throw new Error('CookieCloud 配对已过期或不存在')
    if (pairing.status !== 'waiting') throw new Error('CookieCloud 配对已结束，请重新生成配对信息')
    if (!secureEqual(pairing.uploadToken, uploadToken)) throw new Error('CookieCloud 上传授权码不正确')
    if (!encrypted || encrypted.length > 8 * 1024 * 1024) throw new Error('CookieCloud 加密数据无效或过大')
    if (cryptoType !== 'legacy' && cryptoType !== 'aes-128-cbc-fixed') throw new Error('不支持的 CookieCloud 加密类型')
    if (!this.secrets) throw new Error('服务器尚未配置会话加密密钥')

    const payload = decryptCookieCloud(encrypted, pairing.uuid, pairing.password, cryptoType)
    const site = this.db.getSite(pairing.siteId)
    if (!site) throw new Error('签到站点不存在')
    const snapshot = normalizeCookieCloudPayload(payload, site.baseUrl)
    if (!snapshot.cookies.length && !Object.keys(snapshot.localStorageByHost).length) {
      throw new Error('未读取到目标站点的 Cookie 或 Local Storage，请在 CookieCloud 中填写正确域名并重新上传')
    }

    this.db.saveSiteAuthSnapshot(pairing.siteId, this.secrets.encrypt(JSON.stringify(snapshot)))
    this.db.updateSiteAuth(pairing.siteId, {
      adapter: site.adapter,
      authStatus: 'valid',
      lastError: null,
    })
    pairing.status = 'received'
    pairing.cryptoType = cryptoType
    pairing.receivedAt = nowIso()
    pairing.cookieCount = snapshot.cookies.length
    pairing.localStorageCount = Object.values(snapshot.localStorageByHost).reduce((total, items) => total + Object.keys(items).length, 0)
    pairing.message = '本地登录状态已同步，下一次签到会使用该会话'
    this.events.emit({
      type: 'auth_changed',
      title: '本地授权同步成功',
      message: `${site.name} 已接收 CookieCloud 登录状态`,
      data: { siteId: site.id },
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
      if (!snapshot || !Array.isArray(snapshot.cookies)) return null
      return snapshot
    } catch {
      return null
    }
  }

  close() {
    this.pairings.clear()
  }

  private cleanup() {
    const now = Date.now()
    for (const [id, pairing] of this.pairings) {
      if (pairing.status === 'waiting' && Date.parse(pairing.expiresAt) <= now) {
        pairing.status = 'expired'
        pairing.message = 'CookieCloud 配对已过期，请重新生成'
      }
      if (pairing.status !== 'waiting' && Date.parse(pairing.expiresAt) + PAIR_TTL_MS <= now) this.pairings.delete(id)
    }
  }

  private toStatus(pairing: Pairing): CookieCloudPairingStatus {
    return {
      pairId: pairing.id,
      siteId: pairing.siteId,
      status: pairing.status,
      expiresAt: pairing.expiresAt,
      receivedAt: pairing.receivedAt,
      cookieCount: pairing.cookieCount,
      localStorageCount: pairing.localStorageCount,
      message: pairing.message,
    }
  }
}

export function decryptCookieCloud(
  encrypted: string,
  uuid: string,
  password: string,
  cryptoType: CookieCloudCryptoType = 'legacy',
): CookieCloudPayload {
  const passphrase = createHash('md5').update(`${uuid}-${password}`).digest('hex').slice(0, 16)
  const ciphertext = Buffer.from(encrypted, 'base64')
  let plaintext: Buffer
  if (cryptoType === 'aes-128-cbc-fixed') {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(passphrase, 'utf8'), Buffer.alloc(16))
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } else {
    const salt = ciphertext.subarray(0, 8).toString('ascii') === 'Salted__' ? ciphertext.subarray(8, 16) : null
    const body = salt ? ciphertext.subarray(16) : ciphertext
    const [key, iv] = evpBytesToKey(Buffer.from(passphrase, 'utf8'), salt, 32, 16)
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  }
  const parsed = JSON.parse(plaintext.toString('utf8')) as CookieCloudPayload
  if (!parsed || typeof parsed !== 'object') throw new Error('CookieCloud 数据格式无效')
  return parsed
}

function normalizeCookieCloudPayload(payload: CookieCloudPayload, baseUrl: string): BrowserAuthSnapshot {
  const siteUrl = new URL(baseUrl)
  const siteHost = siteUrl.hostname.toLowerCase()
  const cookieData = isRecord(payload.cookie_data) ? payload.cookie_data : {}
  const cookies: BrowserCookie[] = []
  const seenCookies = new Set<string>()
  for (const [group, values] of Object.entries(cookieData)) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const cookie = normalizeCookie(value, group, siteHost)
      if (!cookie) continue
      const identity = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
      if (seenCookies.has(identity)) continue
      seenCookies.add(identity)
      cookies.push(cookie)
    }
  }

  const localStorageByHost: Record<string, Record<string, string>> = {}
  const storageData = isRecord(payload.local_storage_data) ? payload.local_storage_data : {}
  for (const [rawHost, rawItems] of Object.entries(storageData)) {
    const host = normalizeHost(rawHost)
    if (!host || !isAllowedHost(host, siteHost) || !isRecord(rawItems)) continue
    const items: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawItems)) {
      if (typeof key !== 'string' || !key || typeof value === 'function' || value === undefined) continue
      items[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }
    if (Object.keys(items).length) localStorageByHost[host] = items
  }

  return {
    siteOrigin: siteUrl.origin,
    cookies,
    localStorageByHost,
    updatedAt: nowIso(),
  }
}

function normalizeCookie(value: unknown, group: string, siteHost: string): BrowserCookie | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name : ''
  const cookieValue = typeof value.value === 'string' ? value.value : value.value === undefined ? '' : String(value.value)
  if (!name) return null
  const urlValue = typeof value.url === 'string' ? value.url : null
  let domain = typeof value.domain === 'string' ? value.domain : group
  if (!domain && urlValue) {
    try { domain = new URL(urlValue).hostname } catch { return null }
  }
  const normalizedDomain = domain.trim().toLowerCase()
  const host = normalizeHost(normalizedDomain)
  if (!host || !isAllowedHost(host, siteHost)) return null
  const rawExpiration = value.expirationDate ?? value.expires
  const expires = typeof rawExpiration === 'number' && Number.isFinite(rawExpiration) && rawExpiration > Math.floor(Date.now() / 1000)
    ? Math.floor(rawExpiration)
    : undefined
  const sameSite = normalizeSameSite(value.sameSite)
  return {
    name,
    value: cookieValue,
    domain: normalizedDomain.startsWith('.') ? normalizedDomain : `.${normalizedDomain}`,
    path: typeof value.path === 'string' && value.path.startsWith('/') ? value.path : '/',
    secure: Boolean(value.secure),
    httpOnly: Boolean(value.httpOnly),
    ...(sameSite ? { sameSite } : {}),
    ...(expires ? { expires } : {}),
  }
}

function normalizeSameSite(value: unknown): BrowserCookie['sameSite'] | undefined {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none' || normalized === 'no_restriction') return 'None'
  return undefined
}

function normalizeHost(value: string): string | null {
  const input = value.trim().toLowerCase().replace(/^\.+/, '')
  if (!input) return null
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase()
  } catch {
    return input.split('/')[0]?.split(':')[0] || null
  }
}

function isAllowedHost(candidate: string, target: string): boolean {
  return candidate === target || candidate.endsWith(`.${target}`) || target.endsWith(`.${candidate}`)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function evpBytesToKey(password: Buffer, salt: Buffer | null, keyLength: number, ivLength: number): [Buffer, Buffer] {
  const chunks: Buffer[] = []
  let previous = Buffer.alloc(0)
  while (Buffer.concat(chunks).length < keyLength + ivLength) {
    previous = createHash('md5').update(Buffer.concat([previous, password, salt ?? Buffer.alloc(0)])).digest()
    chunks.push(previous)
  }
  const output = Buffer.concat(chunks)
  return [output.subarray(0, keyLength), output.subarray(keyLength, keyLength + ivLength)]
}
