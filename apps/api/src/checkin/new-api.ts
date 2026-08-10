import { createHash } from 'node:crypto'
import type { BrowserContext, Locator, Page, Request, Response } from 'playwright-core'
import type {
  AdapterType,
  AuthSessionState,
  CheckinResult,
  CheckinStatus,
  Site,
} from './types.js'
import { BrowserManager } from './browser-manager.js'
import { AuthAssistantService, type BrowserAuthSnapshot } from './auth-assistant.js'
import { AppDatabase } from './db.js'
import { EventBus } from './events.js'
import type { RunProgressLog } from './progress.js'
import { localDateKey, nowIso, quotaToAmount, roundAmount, safeMessage } from './utils.js'

interface RemoteResponse<T = unknown> {
  httpStatus: number
  contentType: string
  success: boolean
  data?: T
  message?: string
  code?: string
}

interface RawRemoteResponse {
  httpStatus: number
  contentType: string
  body?: string
  error?: string
}

export function parseRemoteResponseBody<T = unknown>(raw: RawRemoteResponse): RemoteResponse<T> {
  if (raw.error) {
    return {
      httpStatus: raw.httpStatus,
      contentType: raw.contentType,
      success: false,
      message: raw.error,
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw.body ?? '')
  } catch {
    return {
      httpStatus: raw.httpStatus,
      contentType: raw.contentType,
      success: false,
      message: raw.httpStatus === 403
        ? '站点要求浏览器验证，请人工处理'
        : '站点返回了非 JSON 响应',
    }
  }

  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null
  const declaresSuccess = typeof record?.success === 'boolean'
  const declaresOk = typeof record?.ok === 'boolean'
  const declaresCode = typeof record?.code === 'number' || typeof record?.code === 'string'
  const errorMessage = typeof record?.error === 'string'
    ? record.error
    : record?.error && typeof record.error === 'object' && typeof (record.error as Record<string, unknown>).message === 'string'
      ? (record.error as Record<string, unknown>).message as string
      : undefined

  const result: RemoteResponse<T> = {
    httpStatus: raw.httpStatus,
    contentType: raw.contentType,
    success: declaresSuccess
      ? record?.success === true
      : declaresOk
        ? record?.ok === true
        : declaresCode
          ? record?.code === 0 || record?.code === 200 || record?.code === '0' || record?.code === '200'
          : raw.httpStatus >= 200 && raw.httpStatus < 300,
    data: (declaresSuccess || declaresOk || declaresCode ? record?.data ?? payload : payload) as T,
  }
  const message = typeof record?.message === 'string' ? record.message : errorMessage
  if (message !== undefined) result.message = message
  if (typeof record?.code === 'string') result.code = record.code
  return result
}

interface RemoteStatus {
  system_name?: string
  server_address?: string
  checkin_enabled?: boolean
  turnstile_check?: boolean
  quota_per_unit?: number
  quota_display_type?: string
  display_in_currency?: boolean
  usd_exchange_rate?: number
  custom_currency_symbol?: string
  custom_currency_exchange_rate?: number
}

interface RemoteUser {
  id?: number
  username?: string
  display_name?: string
  quota?: number
  balance?: number
}

interface RemoteAuth {
  adapter: AdapterType
  accessToken?: string
  sessionToken?: string
  legacyUserId?: number
  user: RemoteUser
}

interface ModernAccessToken {
  token: string
  expiresAt: number | null
}

interface ModernAccessTokenObserver {
  waitForToken(timeoutMs: number): Promise<ModernAccessToken | null>
  dispose(): void
}

interface AuthenticationProbeState {
  definitiveFailure: boolean
  browserVerificationRequired: boolean
  nonJsonResponse: boolean
}

interface NewApiBalanceRead {
  auth: RemoteAuth
  balance: number
}

interface CheckinStats {
  checked_in_today?: boolean
  records?: Array<{ checkin_date?: string; quota_awarded?: number }>
}

interface CheckinStatusData {
  enabled?: boolean
  checkin_nonce?: string
  captcha_enabled?: boolean
  stats?: CheckinStats
}

interface CheckinSuccessData {
  quota_awarded?: number
  checkin_date?: string
}

interface LocalApiCheckinStatus {
  checked_in_today?: boolean
  can_checkin?: boolean
  at_balance_cap?: boolean
  today_points?: number
  settings?: { enabled?: boolean }
  points?: { balance?: number }
}

interface LocalApiCheckinSuccess {
  record?: { points?: number }
  status?: LocalApiCheckinStatus
}

interface Sub2ApiUser extends RemoteUser {
  email?: string
  balance?: number
}

interface Sub2ApiCheckinStatus {
  signedToday?: boolean
  today?: string
  records?: Array<{ checkin_date?: string; reward_amount?: number }>
  config?: { enabled?: boolean }
}

interface Sub2ApiCheckinResult {
  alreadyChecked?: boolean
  record?: { reward_amount?: number }
  status?: Sub2ApiCheckinStatus
}

interface FengwindWelfareUser extends RemoteUser {
  email?: string
  sub2api_user_id?: number
}

interface FengwindWelfareCheckinStatus {
  enabled?: boolean
  checked_in_today?: boolean
  today?: {
    amount?: number
    total_amount?: number
    status?: string
  } | null
}

interface FengwindWelfareCheckinResult {
  amount?: number
  total_amount?: number
  credited_amount?: number
  status?: string
  record?: { amount?: number }
}

interface HybgzsWelfareUserInfo {
  user?: {
    id?: string
    username?: string
    email?: string
  }
  walletBalance?: number
}

interface HybgzsWelfareCheckinStatus {
  enabled?: boolean
  capRequired?: boolean
}

interface HybgzsWelfareCheckinConfig {
  hasCheckedInToday?: boolean
  todayExpectedReward?: number
  todayCheckinInfo?: {
    rewardQuota?: number
    consecutiveDays?: number
  } | null
}

interface HybgzsWelfareCheckinResult {
  rewardQuota?: number
  consecutiveDays?: number
  deliveryMethod?: string
  walletBalance?: number
  message?: string
}

interface HybgzsWelfarePageState {
  signed: boolean
  challengeVisible: boolean
  errorMessage: string | null
}

interface HybgzsWelfareBalance {
  wallet?: { balance?: number }
  mainSite?: { balance?: number; connected?: boolean }
  total?: number
}

interface HybgzsWelfareMainSiteBalance {
  balance?: number
  connected?: boolean
  withdrawMainSiteBalanceLimit?: number
}

interface ChyTrafficPageState {
  authenticated: boolean
  title: string
  username: string | null
  stats: {
    total: number | null
    used: number | null
    remaining: number | null
  }
  claim: { href: string; text: string } | null
  alreadyClaimed: boolean
}

export interface OfficialApiKeyCandidate {
  id: string
  name: string
  apiKey: string
  keyLast4: string
}

export interface OfficialApiKeyExtraction {
  supported: boolean
  baseUrl: string
  protocol: 'new-api' | 'sub2api'
  keys: OfficialApiKeyCandidate[]
  reason?: string
}

const chyTrafficMoney = { currencySymbol: 'GB', quotaPerUnit: 1, displayScale: 1 }
const aihubMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const sub2ApiMoney = { currencySymbol: '白晶', quotaPerUnit: 1, displayScale: 1 }
const gateAiMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const fengwindWelfareMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const hybgzsWelfareMoney = { currencySymbol: '$', quotaPerUnit: 500_000, displayScale: 1 }
const yiApiMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const trueSotaMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const fastAiTokenMoney = { currencySymbol: '$', quotaPerUnit: 1, displayScale: 1 }
const fengwindMainSiteUrl = 'https://api.fengwind.com/'

export class NewApiService {
  readonly authSessions = new Map<string, AuthSessionState>()

  private readonly interactiveAuthorizationEnabled: boolean
  private readonly modernAccessTokens = new Map<number, ModernAccessToken>()
  private authenticationProbe: AuthenticationProbeState | null = null
  private readonly progress: RunProgressLog | null

  private siteOperationTimeoutMs() {
    return Math.max(1, this.db.getSettings().siteTimeoutSeconds * 1000)
  }

  constructor(
    private readonly db: AppDatabase,
    private readonly browser: BrowserManager,
    private readonly events: EventBus,
    options: { interactiveAuthorizationEnabled?: boolean; authAssistant?: AuthAssistantService; progress?: RunProgressLog } = {},
  ) {
    this.interactiveAuthorizationEnabled = options.interactiveAuthorizationEnabled ?? true
    this.authAssistant = options.authAssistant ?? null
    this.progress = options.progress ?? null
  }

  private readonly authAssistant: AuthAssistantService | null

  private beginAuthenticationProbe(): AuthenticationProbeState {
    const probe = { definitiveFailure: false, browserVerificationRequired: false, nonJsonResponse: false }
    this.authenticationProbe = probe
    return probe
  }

  private noteAuthenticationResponse(response: RemoteResponse): void {
    const probe = this.authenticationProbe ?? this.beginAuthenticationProbe()
    if (isDefinitiveAuthenticationResponse(response)) probe.definitiveFailure = true
    if (isBrowserVerificationResponse(response)) probe.browserVerificationRequired = true
    if (!response.success && !response.contentType.toLowerCase().includes('json') && response.message?.includes('非 JSON')) {
      probe.nonJsonResponse = true
    }
  }

  private logProgress(runId: number, site: Site, message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
    this.progress?.add({ runId, siteId: site.id, siteName: site.name, message, level })
  }

  private loginRemainsValid(site: Site): boolean {
    return site.authStatus === 'valid' && !this.authenticationProbe?.definitiveFailure
  }

  private authenticationRequiredResult(
    site: Site,
    runId: number,
    startedAt: string,
    values: {
      money?: ReturnType<typeof deriveMoneySettings>
      beforeRaw?: number | null
    } = {},
  ): CheckinResult {
    if (this.authenticationProbe?.browserVerificationRequired && this.loginRemainsValid(site)) {
      return this.makeResult(
        site,
        runId,
        startedAt,
        'manual_required',
        '线上服务器浏览器被站点验证拦截，请在本机已授权浏览器完成验证后重新刷新余额',
        { ...values, loginVerified: true },
      )
    }
    const loginVerified = this.loginRemainsValid(site)
    const message = !loginVerified
      ? '登录状态已失效，请重新授权'
      : this.authenticationProbe?.nonJsonResponse
        ? '站点 API 返回了页面而非 JSON，已保留当前登录状态，请确认站点 API 地址'
        : '站点请求暂时不可用，已保留当前登录状态'
    return this.makeResult(
      site,
      runId,
      startedAt,
      loginVerified ? 'failed' : 'manual_required',
      message,
      { ...values, loginVerified },
    )
  }

  private browserVerificationRequiredResult(
    site: Site,
    runId: number,
    startedAt: string,
    values: {
      money?: ReturnType<typeof deriveMoneySettings>
      beforeRaw?: number | null
    } = {},
  ): CheckinResult {
    return this.authenticationRequiredResult(site, runId, startedAt, values)
  }

  private async applyImportedCookies(context: BrowserContext, site: Site): Promise<BrowserAuthSnapshot | null> {
    return this.authAssistant?.applyToContext(context, site.id) ?? null
  }

  private pageIsLoginPath(page: Page): boolean {
    try {
      const pathname = new URL(page.url()).pathname.toLowerCase().replace(/\/+$/, '')
      return /(?:^|\/)(?:login|signin)(?:\/|$)/.test(pathname) || /^\/auth(?:\/|$)/.test(pathname)
    } catch {
      return false
    }
  }

  private async openImportedSitePage(context: BrowserContext, page: Page, site: Site): Promise<void> {
    const snapshot = await this.applyImportedCookies(context, site)
    await this.installImportedStorage(page, site, snapshot)
    await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' })
  }

  private async openBalanceDashboard(page: Page, site: Site): Promise<void> {
    const dashboardUrl = getDashboardUrl(site.baseUrl)
    if (!dashboardUrl) return
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
    await this.openImportedStorage(page, site)
  }

  private async openImportedStorage(page: Page, site: Site): Promise<void> {
    const snapshot = await this.authAssistant?.getSnapshot(site.id) ?? null
    if (!await this.installImportedStorage(page, site, snapshot)) return
    await page.reload({ waitUntil: 'domcontentloaded' })
  }

  private async installImportedStorage(page: Page, _site: Site, snapshot: BrowserAuthSnapshot | null): Promise<boolean> {
    if (!snapshot) return false
    const storageByHost = Object.fromEntries(
      Object.entries(snapshot.localStorageByHost)
        .map(([host, items]) => [host.toLowerCase().replace(/\.$/, ''), items] as const),
    )
    if (!Object.keys(storageByHost).length) return false
    await page.addInitScript(({ storageByHost: importedStorage }) => {
      const currentHost = window.location.hostname.toLowerCase()
      const items = importedStorage[currentHost]
      if (!items) return
      for (const [key, value] of Object.entries(items)) window.localStorage.setItem(key, value)
    }, { storageByHost })
    return true
  }

  async extractOfficialApiKeys(siteId: number): Promise<OfficialApiKeyExtraction> {
    const site = this.db.getSite(siteId)
    if (!site) throw new Error('站点不存在')
    if (site.authStatus !== 'valid') {
      return {
        supported: false,
        baseUrl: site.baseUrl,
        protocol: 'new-api',
        keys: [],
        reason: '请先完成站点授权，再提取官方 API Key',
      }
    }

    const timeoutMs = this.db.getSettings().requestTimeoutSeconds * 1000
    return this.browser.run({ interactive: false, closeBrowserWhenDone: true }, async (context, page) => {
      await this.openImportedSitePage(context, page, site)
      const resolved = await this.resolveOfficialApiImportContext(context, page, site, timeoutMs)
      if (!resolved) {
        return {
          supported: false,
          baseUrl: site.baseUrl,
          protocol: 'new-api',
          keys: [],
          reason: '该站点暂不支持自动提取官方 API Key，请手动添加渠道',
        }
      }
      const keys = resolved.protocol === 'new-api'
        ? await extractNewApiOfficialKeys(page, context, resolved.baseUrl, resolved.headers, timeoutMs)
        : await extractSub2ApiOfficialKeys(page, context, resolved.baseUrl, resolved.headers, timeoutMs)
      if (keys.length) {
        return {
          supported: true,
          baseUrl: resolved.baseUrl,
          protocol: resolved.protocol,
          keys,
        }
      }
      return {
        supported: false,
        baseUrl: resolved.baseUrl,
        protocol: resolved.protocol,
        keys: [],
        reason: `站点未通过官方 API Key 管理接口提供完整 Key，不能安全自动导入（已尝试 ${resolved.protocol === 'new-api' ? 'New API Token 接口' : 'Sub2API API Key 接口'}）`,
      }
    })
  }

  private async resolveOfficialApiImportContext(
    context: BrowserContext,
    page: Page,
    site: Site,
    timeoutMs: number,
  ): Promise<{ baseUrl: string; protocol: 'new-api' | 'sub2api'; headers: Record<string, string> } | null> {
    if (isTrueSotaSite(site.baseUrl)) {
      const auth = await this.detectTrueSotaAuthentication(page, timeoutMs)
      return auth?.accessToken
        ? { baseUrl: site.baseUrl, protocol: 'sub2api', headers: { Authorization: `Bearer ${auth.accessToken}` } }
        : null
    }

    if (site.adapter === 'sub2api' || isSub2ApiSite(site.baseUrl)) {
      const auth = await this.detectSub2ApiAuthentication(page, timeoutMs, site)
      return auth ? { baseUrl: site.baseUrl, protocol: 'sub2api', headers: { Authorization: `Bearer ${auth.accessToken}` } } : null
    }

    if (['local-api', 'fengwind-welfare', 'hybgzs-welfare', 'chy-traffic'].includes(site.adapter)
      || isFengwindWelfareSite(site.baseUrl)
      || isHybgzsWelfareSite(site.baseUrl)
      || isChyTrafficSite(site.baseUrl)) {
      return null
    }

    let status = await this.getRemoteStatus(page, timeoutMs)
    let baseUrl = resolveServerBaseUrl(status.data?.server_address, site.baseUrl)
    if (baseUrl !== site.baseUrl) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      status = await this.getRemoteStatus(page, timeoutMs)
    }

    const auth = await this.detectAuthentication(page, site.legacyUserId, timeoutMs)
    if (auth && ['new-api-modern', 'new-api-legacy'].includes(auth.adapter)) {
      const money = deriveMoneySettings(status.data)
      this.db.updateSiteAuth(site.id, {
        adapter: auth.adapter,
        authStatus: 'valid',
        baseUrl,
        username: auth.user.display_name || auth.user.username || null,
        legacyUserId: auth.legacyUserId ?? null,
        currencySymbol: money.currencySymbol,
        quotaPerUnit: money.quotaPerUnit,
        displayScale: money.displayScale,
        lastBalanceRaw: numberOrNull(auth.user.quota),
        lastBalanceAmount: quotaToAmount(numberOrNull(auth.user.quota), money.quotaPerUnit, money.displayScale),
        lastError: null,
      })
      return { baseUrl, protocol: 'new-api', headers: buildAuthHeaders(auth) }
    }

    // Some New API deployments return a refresh token without embedding the
    // user object. It is still safe to use this bearer only for the official
    // token-management endpoints; the key itself is accepted only after the
    // normal API-key shape checks below.
    const modern = await pageRequest<{ access_token?: string }>(page, '/api/user/auth/refresh', 'POST', {}, timeoutMs)
    if (modern.success && modern.data?.access_token) {
      return { baseUrl, protocol: 'new-api', headers: { Authorization: `Bearer ${modern.data.access_token}` } }
    }
    if (site.adapter === 'new-api-legacy' && site.legacyUserId) {
      return { baseUrl, protocol: 'new-api', headers: { 'New-API-User': String(site.legacyUserId) } }
    }
    return null
  }

  async extractOfficialApiKey(siteId: number): Promise<OfficialApiKeyExtraction> {
    return this.extractOfficialApiKeys(siteId)
  }

  startAuthorization(siteId: number): AuthSessionState {
    const site = this.db.getSite(siteId)
    if (!site) throw new Error('站点不存在')
    if (!this.interactiveAuthorizationEnabled) {
      throw new Error('服务器远程浏览器授权已关闭，请使用本地浏览器授权助手同步登录状态')
    }
    if ([...this.authSessions.values()].some((session) => session.status === 'waiting')) {
      throw new Error('已有授权窗口正在进行，请先完成或取消')
    }

    const id = crypto.randomUUID()
    const state: AuthSessionState = {
      id,
      siteId,
      status: 'waiting',
      message: isSub2ApiSite(site.baseUrl)
        ? '请在打开的浏览器窗口中完成账号密码登录'
        : '请在打开的浏览器窗口中完成站点登录（Linux.do、GitHub 等）',
      startedAt: nowIso(),
      completedAt: null,
    }
    this.authSessions.set(id, state)
    this.db.updateSiteAuth(siteId, {
      adapter: site.adapter,
      authStatus: 'authorizing',
      lastError: null,
    })
    void this.authorizeInBrowser(site, state)
    return state
  }

  getAuthorization(id: string) {
    return this.authSessions.get(id) ?? null
  }

  async cancelAuthorization(id: string) {
    const state = this.authSessions.get(id)
    if (!state || state.status !== 'waiting') return state ?? null
    state.status = 'cancelled'
    state.message = '授权已取消'
    state.completedAt = nowIso()
    await this.browser.cancelActive({ force: false })
    const site = this.db.getSite(state.siteId)
    if (site) {
      this.db.updateSiteAuth(site.id, {
        adapter: site.adapter,
        authStatus: 'expired',
        lastError: '授权已取消',
      })
    }
    return state
  }

  async cancelAuthorizationsForSite(siteId: number): Promise<void> {
    const sessions = [...this.authSessions.values()]
      .filter((session) => session.siteId === siteId && session.status === 'waiting')
    for (const session of sessions) await this.cancelAuthorization(session.id)
  }

  async cancelActiveTask() {
    await this.browser.cancelActive()
  }

  private async authorizeInBrowser(site: Site, state: AuthSessionState) {
    try {
      await this.browser.run({ interactive: true, closeBrowserWhenDone: true }, async (context, page) => {
        const observedLegacyUserIds = new Set<number>()
        const pendingResponseChecks = new Set<Promise<void>>()
        const allowedAuthOrigins = new Set([new URL(site.baseUrl).origin])
        if (typeof page.on === 'function') {
          page.on('response', (response) => {
            const check = inspectLegacyAuthResponse(response, allowedAuthOrigins, observedLegacyUserIds)
              .finally(() => pendingResponseChecks.delete(check))
            pendingResponseChecks.add(check)
          })
        }
        await this.openImportedSitePage(context, page, site)
        const sub2ApiSite = isSub2ApiSite(site.baseUrl)
        const trueSotaSite = isTrueSotaSite(site.baseUrl)
        const fengwindWelfareSite = isFengwindWelfareSite(site.baseUrl)
        const hybgzsWelfareSite = isHybgzsWelfareSite(site.baseUrl)
        const yiApiSite = isYiApiSite(site.baseUrl)
        if (sub2ApiSite) {
          await page.goto(new URL('/login', site.baseUrl).toString(), { waitUntil: 'domcontentloaded' })
        }
        const initialStatus = isChyTrafficSite(site.baseUrl) || sub2ApiSite || trueSotaSite || fengwindWelfareSite || hybgzsWelfareSite || yiApiSite ? null : await this.getRemoteStatus(page)
        const effectiveBaseUrl = resolveServerBaseUrl(initialStatus?.data?.server_address, site.baseUrl)
        allowedAuthOrigins.add(new URL(effectiveBaseUrl).origin)
        if (effectiveBaseUrl !== site.baseUrl) {
          await page.goto(effectiveBaseUrl, { waitUntil: 'domcontentloaded' })
        }
        const deadline = Date.now() + 5 * 60_000
        while (Date.now() < deadline && state.status === 'waiting') {
          if (page.isClosed()) throw new Error('授权窗口已关闭')
          const current = new URL(page.url())
          if (current.origin === effectiveBaseUrl) {
            if (hybgzsWelfareSite) {
              const auth = await this.detectHybgzsWelfareAuthentication(page, 30_000)
              if (auth) {
                const balanceRaw = await this.readHybgzsWelfareBalance(page, 30_000)
                this.db.updateSiteAuth(site.id, {
                  adapter: 'hybgzs-welfare',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user?.username || auth.user?.email || null,
                  currencySymbol: hybgzsWelfareMoney.currencySymbol,
                  quotaPerUnit: hybgzsWelfareMoney.quotaPerUnit,
                  displayScale: hybgzsWelfareMoney.displayScale,
                  lastBalanceRaw: balanceRaw,
                  lastBalanceAmount: quotaToAmount(balanceRaw, hybgzsWelfareMoney.quotaPerUnit, hybgzsWelfareMoney.displayScale),
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为黑与白福利站'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 登录状态已识别`, data: { siteId: site.id } })
                return
              }
            } else if (trueSotaSite) {
              const auth = await this.detectTrueSotaAuthentication(page, 30_000)
              if (auth) {
                const balanceRaw = numberOrNull(auth.user.balance ?? auth.user.quota)
                this.db.updateSiteAuth(site.id, {
                  adapter: 'sub2api',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user.display_name || auth.user.username || null,
                  currencySymbol: trueSotaMoney.currencySymbol,
                  quotaPerUnit: trueSotaMoney.quotaPerUnit,
                  displayScale: trueSotaMoney.displayScale,
                  lastBalanceRaw: balanceRaw,
                  lastBalanceAmount: quotaToAmount(balanceRaw, trueSotaMoney.quotaPerUnit, trueSotaMoney.displayScale),
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为 TrueSOTA'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已可自动读取余额`, data: { siteId: site.id } })
                return
              }
            } else if (fengwindWelfareSite) {
              const auth = await this.detectFengwindWelfareAuthentication(page, 30_000)
              if (auth) {
                this.db.updateSiteAuth(site.id, {
                  adapter: 'fengwind-welfare',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user.username || auth.user.email || null,
                  currencySymbol: fengwindWelfareMoney.currencySymbol,
                  quotaPerUnit: fengwindWelfareMoney.quotaPerUnit,
                  displayScale: fengwindWelfareMoney.displayScale,
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为 Fengwind 福利站'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已可自动签到`, data: { siteId: site.id } })
                return
              }
            } else if (sub2ApiSite) {
              const auth = await this.detectSub2ApiAuthentication(page, 30_000, site)
              if (auth) {
                const money = moneyForSub2ApiSite(site)
                this.db.updateSiteAuth(site.id, {
                  adapter: 'sub2api',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user.username || auth.user.email || null,
                  currencySymbol: money.currencySymbol,
                  quotaPerUnit: money.quotaPerUnit,
                  displayScale: money.displayScale,
                  lastBalanceRaw: numberOrNull(auth.user.balance),
                  lastBalanceAmount: quotaToAmount(numberOrNull(auth.user.balance), money.quotaPerUnit, money.displayScale),
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为 Sub2API'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已可自动签到`, data: { siteId: site.id } })
                return
              }
            } else if (yiApiSite) {
              const auth = await this.detectYiApiAuthentication(page, 30_000)
              if (auth) {
                const balanceRaw = numberOrNull(auth.user.balance ?? auth.user.quota)
                this.db.updateSiteAuth(site.id, {
                  adapter: 'new-api-modern',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user.display_name || auth.user.username || null,
                  currencySymbol: yiApiMoney.currencySymbol,
                  quotaPerUnit: yiApiMoney.quotaPerUnit,
                  displayScale: yiApiMoney.displayScale,
                  lastBalanceRaw: balanceRaw,
                  lastBalanceAmount: quotaToAmount(balanceRaw, yiApiMoney.quotaPerUnit, yiApiMoney.displayScale),
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为 YiAPI'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已记录 YiAPI 登录状态`, data: { siteId: site.id } })
                return
              }
            } else if (isChyTrafficSite(effectiveBaseUrl)) {
              const traffic = await readChyTrafficPage(page)
              if (traffic.authenticated) {
                this.db.updateSiteAuth(site.id, {
                  adapter: 'chy-traffic',
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: traffic.username,
                  currencySymbol: chyTrafficMoney.currencySymbol,
                  quotaPerUnit: chyTrafficMoney.quotaPerUnit,
                  displayScale: chyTrafficMoney.displayScale,
                  lastError: null,
                })
                state.status = 'success'
                state.message = '授权成功，已识别为 CHY 流量签到'
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已可自动签到`, data: { siteId: site.id } })
                return
              }
            } else {
              await Promise.all([...pendingResponseChecks])
              const auth = await this.detectAuthentication(page, site.legacyUserId, 30_000, true, observedLegacyUserIds)
              if (auth) {
                const status = await this.getRemoteStatus(page)
                const money = auth.adapter === 'local-api'
                  ? { currencySymbol: 'P', quotaPerUnit: 1, displayScale: 1 }
                  : deriveMoneySettings(status.data)
                const balanceRaw = numberOrNull(auth.user.quota)
                this.db.updateSiteAuth(site.id, {
                  adapter: auth.adapter,
                  authStatus: 'valid',
                  baseUrl: effectiveBaseUrl,
                  username: auth.user.display_name || auth.user.username || null,
                  legacyUserId: auth.legacyUserId ?? null,
                  currencySymbol: money.currencySymbol,
                  quotaPerUnit: money.quotaPerUnit,
                  displayScale: money.displayScale,
                  lastBalanceRaw: balanceRaw,
                  lastBalanceAmount: quotaToAmount(balanceRaw, money.quotaPerUnit, money.displayScale),
                  lastError: null,
                })
                state.status = 'success'
                state.message = `授权成功，已识别为 ${adapterLabel(auth.adapter)}`
                state.completedAt = nowIso()
                this.events.emit({ type: 'auth_changed', title: '站点授权成功', message: `${site.name} 已可自动签到`, data: { siteId: site.id } })
                return
              }
            }
          }
          await page.waitForTimeout(4000)
        }
        if (state.status === 'waiting') throw new Error('授权超时，请重新发起授权')
      })
    } catch (error) {
      if (state.status === 'cancelled') return
      const message = safeMessage(error, '授权失败')
      state.status = 'failed'
      state.message = message
      state.completedAt = nowIso()
      this.db.updateSiteAuth(site.id, {
        adapter: site.adapter,
        authStatus: 'expired',
        lastError: message,
      })
      this.events.emit({ type: 'auth_changed', title: '站点授权失败', message: `${site.name}: ${message}`, data: { siteId: site.id } })
    }
  }

  async checkinSite(site: Site, runId: number, siteTimeoutMs = this.siteOperationTimeoutMs()): Promise<CheckinResult> {
    const startedAt = nowIso()
    const requestTimeoutMs = this.db.getSettings().requestTimeoutSeconds * 1000
    this.db.markSiteRunning(site.id)
    try {
      return await this.browser.run({
        interactive: isHybgzsWelfareSite(site.baseUrl) || site.adapter === 'hybgzs-welfare',
        closeBrowserWhenDone: true,
        timeoutMs: siteTimeoutMs,
      }, async (context, page) => {
        this.beginAuthenticationProbe()
        const modernAccessToken = observeModernAccessToken(page, site.baseUrl, this.getCachedModernAccessToken(site.id))
        await this.openImportedSitePage(context, page, site)
        this.logProgress(runId, site, '站点页面已打开，正在检测签到能力')
        if (this.pageIsLoginPath(page)) {
          return this.makeResult(site, runId, startedAt, 'manual_required', '站点已跳转到登录页，请重新授权', {
            loginVerified: false,
          })
        }
        const challenge = await detectChallenge(page)
        if (challenge) {
          return this.makeResult(site, runId, startedAt, 'manual_required', challenge, {
            loginVerified: this.loginRemainsValid(site),
          })
        }

        if (isChyTrafficSite(site.baseUrl)) {
          return this.checkinChyTrafficSite(page, site, runId, startedAt)
        }
        if (site.adapter === 'hybgzs-welfare' || isHybgzsWelfareSite(site.baseUrl)) {
          return this.checkinHybgzsWelfareSite(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (site.adapter === 'fengwind-welfare' || isFengwindWelfareSite(site.baseUrl)) {
          return this.checkinFengwindWelfareSite(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (isTrueSotaSite(site.baseUrl)) {
          return this.refreshTrueSotaBalance(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (site.adapter === 'sub2api' || isSub2ApiSite(site.baseUrl)) {
          return this.checkinSub2ApiSite(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (isAnyRouterSite(site.baseUrl)) {
          return this.checkinPageTriggeredSite(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (isYiApiSite(site.baseUrl)) {
          return this.refreshYiApiBalance(page, site, runId, startedAt, requestTimeoutMs)
        }

        const statusResponse = await this.getRemoteStatus(page, requestTimeoutMs)
        this.logProgress(runId, site, '已读取站点配置')
        const remoteStatus = statusResponse.data
        const money = deriveMoneySettings(remoteStatus)
        // New API 1.1+ rotates the dashboard refresh cookie whenever this
        // endpoint is called. A site with check-in disabled does not need an
        // authenticated request, so avoid rotating the user's session just
        // to discover that there is nothing to claim.
        if (remoteStatus?.checkin_enabled === false) {
          const balanceRead = await this.readNewApiBalanceWithoutRefresh(page, site, requestTimeoutMs, modernAccessToken)
          if (balanceRead) this.persistNewApiBalance(site, balanceRead, money)
          if (balanceRead === null && !this.loginRemainsValid(site)) {
            return this.authenticationRequiredResult(site, runId, startedAt, {
              money,
              beforeRaw: site.lastBalanceRaw,
            })
          }
          const message = balanceRead === null ? '签到功能未启用' : '签到功能未启用，余额已刷新'
          return this.makeResult(site, runId, startedAt, 'disabled', message, {
            beforeRaw: site.lastBalanceRaw,
            ...(balanceRead ? { afterRaw: balanceRead.balance } : {}),
            money,
            loginVerified: balanceRead !== null || this.loginRemainsValid(site),
          })
        }

        const auth = await this.detectAuthentication(page, site.legacyUserId, requestTimeoutMs)
        if (!auth) return this.authenticationRequiredResult(site, runId, startedAt)
        this.logProgress(runId, site, '登录状态有效，开始执行签到')
        if (auth.adapter === 'local-api') {
          return this.checkinLocalApiSite(page, site, runId, startedAt, auth, requestTimeoutMs)
        }

        const authHeaders = buildAuthHeaders(auth)
        const beforeUserResponse = await pageRequest<unknown>(page, '/api/user/self', 'GET', authHeaders, requestTimeoutMs)
        const beforeUser = beforeUserResponse.success ? normalizeNewApiUser(beforeUserResponse.data) : null
        const beforeRaw = beforeUser ? newApiUserBalance(beforeUser) : null
        if (beforeUser && beforeRaw !== null) {
          this.persistNewApiBalance(site, { auth: { ...auth, user: beforeUser }, balance: beforeRaw }, money)
        }

        const month = localDateKey(new Date()).slice(0, 7)
        const checkinStatus = await pageRequest<CheckinStatusData>(page, `/api/user/checkin?month=${month}`, 'GET', authHeaders, requestTimeoutMs)
        if (!checkinStatus.success) {
          if (isUnsupportedNewApiCheckinEndpoint(checkinStatus)) {
            this.db.updateSiteCheckinMode(site.id, 'balance_only')
            const balanceMessage = beforeRaw === null
              ? '该站点不支持自动签到，未读取到最新余额'
              : '该站点不支持自动签到，余额已刷新'
            return this.makeResult(site, runId, startedAt, 'disabled', balanceMessage, {
              beforeRaw,
              afterRaw: beforeRaw,
              money,
              loginVerified: true,
            })
          }
          const message = checkinStatus.message || '无法读取签到状态'
          const definitiveFailure = isDefinitiveAuthenticationFailure(checkinStatus) || isLoginRelatedMessage(message)
          if (isManualMessage(message) || definitiveFailure) {
            return this.makeResult(site, runId, startedAt, 'manual_required', message, {
              beforeRaw,
              money,
              loginVerified: !definitiveFailure,
            })
          }
          if (message.includes('未启用')) return this.makeResult(site, runId, startedAt, 'disabled', message, { beforeRaw, afterRaw: beforeRaw, money, loginVerified: true })
          return this.makeResult(site, runId, startedAt, 'failed', message, { beforeRaw, money, loginVerified: true })
        }

        const todayRecord = findTodayRecord(checkinStatus.data?.stats?.records)
        if (checkinStatus.data?.stats?.checked_in_today) {
          const rewardRaw = numberOrNull(todayRecord?.quota_awarded)
          return this.makeResult(site, runId, startedAt, 'already_checked', '今日已签到', {
            rewardRaw,
            beforeRaw,
            afterRaw: beforeRaw,
            money,
          })
        }

        // 以下两个分支都发生在登录已确认有效之后（detectAuthentication 通过、/api/user/self 可读），
        // 只是签到那一步需要人工完成。标记 loginVerified 让登录列保持“登录有效”，
        // 只有签到列显示“需人工处理”。
        if (remoteStatus?.turnstile_check) {
          return this.makeResult(site, runId, startedAt, 'manual_required', '站点启用了人机验证，请打开授权窗口手动完成', { beforeRaw, money, loginVerified: true })
        }

        if (checkinStatus.data?.captcha_enabled) {
          return this.makeResult(site, runId, startedAt, 'manual_required', '该站点签到需要输入验证码，请在“站点管理”中点击“重新授权/签到”手动完成', { beforeRaw, money, loginVerified: true })
        }

        const checkinHeaders = buildCheckinHeaders(auth, checkinStatus.data?.checkin_nonce)
        this.logProgress(runId, site, '正在提交签到请求')
        const checkin = await pageRequest<CheckinSuccessData>(page, '/api/user/checkin', 'POST', checkinHeaders, requestTimeoutMs)
        if (!checkin.success) {
          const message = checkin.message || '签到失败'
          // 签到接口报错时，只有提示与登录/授权相关才认为登录失效；验证码之类的
          // 报错说明登录仍有效，只是这一步需要人工。
          const definitiveFailure = isDefinitiveAuthenticationFailure(checkin) || isLoginRelatedMessage(message)
          return this.makeResult(site, runId, startedAt, isManualMessage(message) || definitiveFailure ? 'manual_required' : 'failed', message, {
            beforeRaw,
            money,
            loginVerified: !definitiveFailure,
          })
        }

        this.logProgress(runId, site, '签到请求已提交成功', 'success')
        const afterUserResponse = await pageRequest<unknown>(page, '/api/user/self', 'GET', authHeaders, requestTimeoutMs)
        this.noteAuthenticationResponse(afterUserResponse)
        const afterUser = afterUserResponse.success ? normalizeNewApiUser(afterUserResponse.data) : null
        const afterRaw = afterUser ? newApiUserBalance(afterUser) : null
        return this.makeResult(site, runId, startedAt, 'success', checkin.message || '签到成功', {
          rewardRaw: numberOrNull(checkin.data?.quota_awarded),
          beforeRaw,
          afterRaw,
          money,
        })
      })
    } catch (error) {
      const message = safeMessage(error, '签到请求失败')
      const status: CheckinStatus = isManualMessage(message) ? 'manual_required' : 'failed'
      return this.makeResult(site, runId, startedAt, status, message)
    }
  }

  async refreshBalanceSite(site: Site, runId: number, siteTimeoutMs = this.siteOperationTimeoutMs()): Promise<CheckinResult> {
    const startedAt = nowIso()
    const requestTimeoutMs = this.db.getSettings().requestTimeoutSeconds * 1000
    this.db.markSiteRunning(site.id)
    try {
      return await this.browser.run({ interactive: false, closeBrowserWhenDone: true, timeoutMs: siteTimeoutMs }, async (context, page) => {
        this.beginAuthenticationProbe()
        const modernAccessToken = observeModernAccessToken(page, site.baseUrl, this.getCachedModernAccessToken(site.id))
        await this.applyImportedCookies(context, site)
        this.logProgress(runId, site, '已恢复登录状态，正在读取余额')
        const noPageBalance = ['new-api-modern', 'new-api-legacy'].includes(site.adapter)
          ? await this.tryReadNewApiBalanceWithoutPage(context, site, requestTimeoutMs)
          : { kind: 'skip' as const }
        if (noPageBalance.kind === 'success') {
          this.persistNewApiBalance(site, noPageBalance.read, noPageBalance.money)
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: noPageBalance.read.balance,
            money: noPageBalance.money,
            loginVerified: true,
          })
        }
        if (noPageBalance.kind === 'auth_failed') {
          return this.authenticationRequiredResult(site, runId, startedAt, {
            money: noPageBalance.money,
            beforeRaw: site.lastBalanceRaw,
          })
        }
        if (isTrueSotaSite(site.baseUrl)) {
          await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' })
          await this.openImportedStorage(page, site)
          return this.refreshTrueSotaBalance(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (isYiApiSite(site.baseUrl)) {
          await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' })
          await this.openImportedStorage(page, site)
          return this.refreshYiApiBalance(page, site, runId, startedAt, requestTimeoutMs)
        }
        if (site.adapter === 'hybgzs-welfare' || isHybgzsWelfareSite(site.baseUrl)) {
          await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' })
          await this.openImportedStorage(page, site)
          const auth = await this.detectHybgzsWelfareAuthentication(page, requestTimeoutMs)
          if (!auth) {
            return this.browserVerificationRequiredResult(site, runId, startedAt, { money: hybgzsWelfareMoney })
          }
          const balance = await this.readHybgzsWelfareBalance(page, requestTimeoutMs)
          if (balance === null) {
            return this.makeResult(site, runId, startedAt, 'failed', '无法读取黑与白福利站余额', { money: hybgzsWelfareMoney, loginVerified: true })
          }
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: balance,
            money: hybgzsWelfareMoney,
            loginVerified: true,
          })
        }

        if (site.adapter === 'fengwind-welfare' || isFengwindWelfareSite(site.baseUrl)) {
          const balance = await this.readFengwindMainSiteBalance(page, requestTimeoutMs)
          if (balance === null) {
            return this.authenticationRequiredResult(site, runId, startedAt, { money: fengwindWelfareMoney })
          }
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: balance,
            money: fengwindWelfareMoney,
          })
        }

        if (isAnyRouterSite(site.baseUrl)) {
          await this.openBalanceDashboard(page, site)
        } else {
          await this.openImportedSitePage(context, page, site)
          if (isFastAiTokenSite(site.baseUrl)) {
            const dashboardUrl = getDashboardUrl(site.baseUrl)
            if (dashboardUrl) await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
          }
        }
        const sub2ApiSite = site.adapter === 'sub2api' || isSub2ApiSite(site.baseUrl)
        if (this.pageIsLoginPath(page)) {
          return this.makeResult(site, runId, startedAt, 'manual_required', '站点已跳转到登录页，请重新授权', {
            loginVerified: false,
          })
        }
        const challenge = await detectChallenge(page)
        // Sub2API exposes its authenticated balance API even when the public
        // SPA shell is behind a browser-verification page (for example Aihub).
        // Try the imported bearer token before treating that shell as a
        // manual-only challenge.
        if (challenge && !sub2ApiSite) {
          return this.makeResult(site, runId, startedAt, 'manual_required', challenge, {
            loginVerified: this.loginRemainsValid(site),
          })
        }

        if (isChyTrafficSite(site.baseUrl)) {
          const traffic = await readChyTrafficPage(page)
          if (!traffic.authenticated) {
            return this.authenticationRequiredResult(site, runId, startedAt, { money: chyTrafficMoney })
          }
          if (traffic.stats.remaining === null) {
            return this.makeResult(site, runId, startedAt, 'failed', '无法读取站点剩余流量', { money: chyTrafficMoney })
          }
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: traffic.stats.remaining,
            money: chyTrafficMoney,
          })
        }

        if (sub2ApiSite) {
          const auth = await this.detectSub2ApiAuthentication(page, requestTimeoutMs, site)
          const money = moneyForSub2ApiSite(site)
          if (!auth) {
            if (challenge) {
              return this.makeResult(site, runId, startedAt, 'manual_required', challenge, {
                money,
                loginVerified: this.loginRemainsValid(site),
              })
            }
            return this.authenticationRequiredResult(site, runId, startedAt, { money })
          }
          const balance = numberOrNull(auth.user.balance)
          if (balance === null) {
            return this.makeResult(site, runId, startedAt, 'failed', '无法读取 Sub2API 余额', { money, loginVerified: true })
          }
          this.db.updateSiteAuth(site.id, {
            adapter: 'sub2api',
            authStatus: 'valid',
            baseUrl: site.baseUrl,
            username: auth.user.username || auth.user.email || null,
            currencySymbol: money.currencySymbol,
            quotaPerUnit: money.quotaPerUnit,
            displayScale: money.displayScale,
            lastBalanceRaw: balance,
            lastBalanceAmount: quotaToAmount(balance, money.quotaPerUnit, money.displayScale),
            lastError: null,
          })
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: balance,
            money,
            loginVerified: true,
          })
        }

        const statusResponse = await this.getRemoteStatus(page, requestTimeoutMs)
        if (statusResponse.success && statusResponse.data?.checkin_enabled === false) {
          const money = deriveMoneySettings(statusResponse.data)
          const balanceRead = await this.readNewApiBalanceWithoutRefresh(page, site, requestTimeoutMs, modernAccessToken)
          if (balanceRead) this.persistNewApiBalance(site, balanceRead, money)
          if (balanceRead === null && !this.loginRemainsValid(site)) {
            return this.authenticationRequiredResult(site, runId, startedAt, {
              money,
              beforeRaw: site.lastBalanceRaw,
            })
          }
          const message = balanceRead === null ? '自动签到已关闭，未读取到最新余额' : '自动签到已关闭，余额已刷新'
          return this.makeResult(site, runId, startedAt, 'disabled', message, {
            beforeRaw: site.lastBalanceRaw,
            ...(balanceRead ? { afterRaw: balanceRead.balance } : {}),
            money,
            loginVerified: balanceRead !== null || this.loginRemainsValid(site),
          })
        }

        if (!isAnyRouterSite(site.baseUrl)) await this.openBalanceDashboard(page, site)
        const auth = await this.detectAuthentication(page, site.legacyUserId, requestTimeoutMs)
        if (!auth) return this.authenticationRequiredResult(site, runId, startedAt)

        if (auth.adapter === 'local-api') {
          const status = await pageRequest<LocalApiCheckinStatus>(page, '/user/api/checkin', 'GET', buildAuthHeaders(auth), requestTimeoutMs)
          this.noteAuthenticationResponse(status)
          if (!status.success) {
            const message = status.message || '无法读取 LocalAPI 积分余额'
            const definitiveFailure = isDefinitiveAuthenticationFailure(status) || isLoginRelatedMessage(message)
            return this.makeResult(site, runId, startedAt, isManualMessage(message) || definitiveFailure ? 'manual_required' : 'failed', message, {
              money: { currencySymbol: 'P', quotaPerUnit: 1, displayScale: 1 },
              loginVerified: !definitiveFailure,
            })
          }
          const balance = numberOrNull(status.data?.points?.balance)
          return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
            beforeRaw: site.lastBalanceRaw,
            afterRaw: balance,
            money: { currencySymbol: 'P', quotaPerUnit: 1, displayScale: 1 },
          })
        }

        const balance = newApiUserBalance(auth.user)
        const money = deriveMoneySettings(statusResponse.data)
        if (balance === null) {
          return this.makeResult(site, runId, startedAt, 'failed', '无法读取站点余额', { money, loginVerified: true })
        }
        this.persistNewApiBalance(site, { auth, balance }, money)
        return this.makeResult(site, runId, startedAt, 'disabled', '自动签到已关闭，余额已刷新', {
          beforeRaw: site.lastBalanceRaw,
          afterRaw: balance,
          money,
          loginVerified: true,
        })
      })
    } catch (error) {
      const message = safeMessage(error, '余额刷新失败')
      return this.makeResult(site, runId, startedAt, isManualMessage(message) ? 'manual_required' : 'failed', message)
    }
  }

  private makeResult(
    site: Site,
    runId: number,
    startedAt: string,
    status: CheckinStatus,
    message: string,
    values: {
      rewardRaw?: number | null
      beforeRaw?: number | null
      afterRaw?: number | null
      money?: ReturnType<typeof deriveMoneySettings>
      loginVerified?: boolean
    } = {},
  ): CheckinResult {
    const money = values.money ?? {
      currencySymbol: site.currencySymbol,
      quotaPerUnit: site.quotaPerUnit,
      displayScale: site.displayScale,
    }
    const rewardRaw = values.rewardRaw ?? null
    const balanceBeforeRaw = values.beforeRaw ?? null
    const balanceAfterRaw = values.afterRaw ?? (
      status === 'success' && balanceBeforeRaw !== null && rewardRaw !== null
        ? balanceBeforeRaw + rewardRaw
        : balanceBeforeRaw
    )
    const rewardAmount = quotaToAmount(rewardRaw, money.quotaPerUnit, money.displayScale)
    const balanceBeforeAmount = quotaToAmount(balanceBeforeRaw, money.quotaPerUnit, money.displayScale)
    const balanceAfterAmount = quotaToAmount(balanceAfterRaw, money.quotaPerUnit, money.displayScale)
    const balanceDeltaAmount = balanceBeforeAmount !== null && balanceAfterAmount !== null
      ? roundAmount(balanceAfterAmount - balanceBeforeAmount)
      : null
    const balanceUpdated = (values.afterRaw !== undefined && values.afterRaw !== null)
      || (status === 'success' && rewardRaw !== null && balanceBeforeRaw !== null)
      || (status === 'already_checked' && balanceBeforeRaw !== null)
    return {
      id: 0,
      runId,
      siteId: site.id,
      siteName: site.name,
      status,
      rewardRaw,
      rewardAmount,
      balanceBeforeRaw,
      balanceBeforeAmount,
      balanceAfterRaw,
      balanceAfterAmount,
      balanceDeltaAmount,
      balanceUpdated,
      message,
      startedAt,
      completedAt: nowIso(),
      loginVerified: values.loginVerified,
    }
  }

  private async checkinLocalApiSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    auth: RemoteAuth,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    const headers = buildAuthHeaders(auth)
    const money = { currencySymbol: 'P', quotaPerUnit: 1, displayScale: 1 }
    const before = await pageRequest<LocalApiCheckinStatus>(page, '/user/api/checkin', 'GET', headers, timeoutMs)
    this.noteAuthenticationResponse(before)
    if (!before.success) {
      const message = before.message || '无法读取 LocalAPI 签到状态'
      const definitiveFailure = isDefinitiveAuthenticationFailure(before) || isLoginRelatedMessage(message)
      const status: CheckinStatus = isManualMessage(message) || definitiveFailure ? 'manual_required' : 'failed'
      return this.makeResult(site, runId, startedAt, status, message, { money, loginVerified: !definitiveFailure })
    }

    const beforePoints = numberOrNull(before.data?.points?.balance)
    if (before.data?.checked_in_today) {
      return this.makeResult(site, runId, startedAt, 'already_checked', '今日已签到', {
        rewardRaw: numberOrNull(before.data.today_points),
        beforeRaw: beforePoints,
        afterRaw: beforePoints,
        money,
      })
    }
    if (before.data?.settings?.enabled === false) {
      return this.makeResult(site, runId, startedAt, 'disabled', '签到功能未启用', { beforeRaw: beforePoints, afterRaw: beforePoints, money })
    }
    if (before.data?.can_checkin === false) {
      const message = before.data.at_balance_cap ? '积分持有已达上限' : '当前不可签到'
      return this.makeResult(site, runId, startedAt, 'failed', message, { beforeRaw: beforePoints, money })
    }

    const checkin = await pageRequest<LocalApiCheckinSuccess>(page, '/user/api/checkin', 'POST', headers, timeoutMs)
    this.noteAuthenticationResponse(checkin)
    if (!checkin.success) {
      const message = checkin.message || '签到失败'
      const definitiveFailure = isDefinitiveAuthenticationFailure(checkin) || isLoginRelatedMessage(message)
      return this.makeResult(site, runId, startedAt, isManualMessage(message) || definitiveFailure ? 'manual_required' : 'failed', message, {
        beforeRaw: beforePoints,
        money,
        loginVerified: !definitiveFailure,
      })
    }
    const afterPoints = numberOrNull(checkin.data?.status?.points?.balance)
    return this.makeResult(site, runId, startedAt, 'success', '签到成功', {
      rewardRaw: numberOrNull(checkin.data?.record?.points),
      beforeRaw: beforePoints,
      afterRaw: afterPoints,
      money,
    })
  }

  private async checkinSub2ApiSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    const money = moneyForSub2ApiSite(site)
    const auth = await this.detectSub2ApiAuthentication(page, timeoutMs, site)
    if (!auth) {
      return this.authenticationRequiredResult(site, runId, startedAt, { money })
    }
    this.db.updateSiteAuth(site.id, {
      adapter: 'sub2api',
      authStatus: 'valid',
      username: auth.user.username || auth.user.email || null,
      currencySymbol: money.currencySymbol,
      quotaPerUnit: money.quotaPerUnit,
      displayScale: money.displayScale,
      lastError: null,
    })

    const headers = { Authorization: `Bearer ${auth.accessToken}` }
    const beforeBalance = numberOrNull(auth.user.balance)
    const statusResponse = await pageRequest<Sub2ApiCheckinStatus>(page, '/checkin/api/status', 'GET', headers, timeoutMs)
    this.noteAuthenticationResponse(statusResponse)
    if (!statusResponse.success) {
      const message = statusResponse.message || '无法读取 Sub2API 签到状态'
      const definitiveFailure = isDefinitiveAuthenticationFailure(statusResponse)
      const status: CheckinStatus = definitiveFailure || isManualMessage(message)
        ? 'manual_required'
        : 'failed'
      return this.makeResult(site, runId, startedAt, status, message, {
        beforeRaw: beforeBalance,
        money,
        loginVerified: !definitiveFailure,
      })
    }

    if (statusResponse.data?.config?.enabled === false) {
      return this.makeResult(site, runId, startedAt, 'disabled', '签到功能未启用', { beforeRaw: beforeBalance, afterRaw: beforeBalance, money })
    }
    if (statusResponse.data?.signedToday) {
      const today = statusResponse.data.today || localDateKey(new Date())
      const record = statusResponse.data.records?.find((item) => item.checkin_date === today)
      return this.makeResult(site, runId, startedAt, 'already_checked', '今日已签到', {
        rewardRaw: numberOrNull(record?.reward_amount),
        beforeRaw: beforeBalance,
        afterRaw: beforeBalance,
        money,
      })
    }

    const checkin = await pageRequest<Sub2ApiCheckinResult>(page, '/checkin/api/checkin', 'POST', headers, timeoutMs)
    this.noteAuthenticationResponse(checkin)
    if (!checkin.success) {
      const message = checkin.message || '签到失败'
      const definitiveFailure = isDefinitiveAuthenticationFailure(checkin)
      const status: CheckinStatus = definitiveFailure || isManualMessage(message)
        ? 'manual_required'
        : 'failed'
      return this.makeResult(site, runId, startedAt, status, message, {
        beforeRaw: beforeBalance,
        money,
        loginVerified: !definitiveFailure,
      })
    }

    const reward = numberOrNull(checkin.data?.record?.reward_amount)
    const afterAuth = await this.detectSub2ApiAuthentication(page, timeoutMs, site)
    const afterBalance = numberOrNull(afterAuth?.user.balance)
    const alreadyChecked = checkin.data?.alreadyChecked === true
    return this.makeResult(site, runId, startedAt, alreadyChecked ? 'already_checked' : 'success', alreadyChecked ? '今日已签到' : '签到成功', {
      rewardRaw: reward,
      beforeRaw: beforeBalance,
      afterRaw: afterBalance,
      money,
    })
  }

  private async checkinFengwindWelfareSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    const auth = await this.detectFengwindWelfareAuthentication(page, timeoutMs)
    if (!auth) {
      return this.authenticationRequiredResult(site, runId, startedAt, { money: fengwindWelfareMoney })
    }
    this.db.updateSiteAuth(site.id, {
      adapter: 'fengwind-welfare',
      authStatus: 'valid',
      username: auth.user.username || auth.user.email || null,
      currencySymbol: fengwindWelfareMoney.currencySymbol,
      quotaPerUnit: fengwindWelfareMoney.quotaPerUnit,
      displayScale: fengwindWelfareMoney.displayScale,
      lastError: null,
    })

    const headers = { Authorization: `Bearer ${auth.accessToken}` }
    const statusResponse = await pageRequest<FengwindWelfareCheckinStatus>(page, '/api/checkin/status', 'GET', headers, timeoutMs)
    this.noteAuthenticationResponse(statusResponse)
    if (!statusResponse.success) {
      const message = statusResponse.message || '无法读取 Fengwind 福利站签到状态'
      const definitiveFailure = isDefinitiveAuthenticationFailure(statusResponse)
      const status: CheckinStatus = definitiveFailure || isManualMessage(message)
        ? 'manual_required'
        : 'failed'
      return this.makeResult(site, runId, startedAt, status, message, {
        money: fengwindWelfareMoney,
        loginVerified: !definitiveFailure,
      })
    }
    if (statusResponse.data?.enabled === false) {
      return this.makeResult(site, runId, startedAt, 'disabled', '签到功能未启用', { money: fengwindWelfareMoney })
    }
    if (statusResponse.data?.checked_in_today) {
      const reward = numberOrNull(statusResponse.data.today?.amount ?? statusResponse.data.today?.total_amount)
      const mainBalance = await this.readFengwindMainSiteBalance(page, timeoutMs)
      return this.makeResult(site, runId, startedAt, 'already_checked', '今日已签到', {
        rewardRaw: reward,
        beforeRaw: site.lastBalanceRaw,
        afterRaw: mainBalance,
        money: fengwindWelfareMoney,
      })
    }

    const checkin = await pageRequest<FengwindWelfareCheckinResult>(page, '/api/checkin', 'POST', headers, timeoutMs)
    this.noteAuthenticationResponse(checkin)
    if (!checkin.success) {
      const message = checkin.message || '签到失败'
      const definitiveFailure = isDefinitiveAuthenticationFailure(checkin)
      const status: CheckinStatus = definitiveFailure || isManualMessage(message)
        ? 'manual_required'
        : isAlreadyCheckedMessage(message)
          ? 'already_checked'
          : 'failed'
      return this.makeResult(site, runId, startedAt, status, message, {
        money: fengwindWelfareMoney,
        loginVerified: !definitiveFailure,
      })
    }

    const reward = numberOrNull(
      checkin.data?.amount
      ?? checkin.data?.total_amount
      ?? checkin.data?.credited_amount
      ?? checkin.data?.record?.amount,
    )
    const alreadyChecked = isAlreadyCheckedMessage(checkin.message || '')
    const mainBalance = await this.readFengwindMainSiteBalance(page, timeoutMs)
    return this.makeResult(site, runId, startedAt, alreadyChecked ? 'already_checked' : 'success', alreadyChecked ? '今日已签到' : '签到成功', {
      rewardRaw: reward,
      beforeRaw: site.lastBalanceRaw,
      afterRaw: mainBalance,
      money: fengwindWelfareMoney,
    })
  }

  private async checkinHybgzsWelfareSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    await page.goto(new URL('/gas-station/checkin', site.baseUrl).toString(), { waitUntil: 'domcontentloaded' })
    const auth = await this.detectHybgzsWelfareAuthentication(page, timeoutMs)
    if (!auth) {
      return this.browserVerificationRequiredResult(site, runId, startedAt, { money: hybgzsWelfareMoney })
    }

    const beforeRaw = await this.readHybgzsWelfareBalance(page, timeoutMs)
    this.db.updateSiteAuth(site.id, {
      adapter: 'hybgzs-welfare',
      authStatus: 'valid',
      username: auth.user?.username || auth.user?.email || null,
      currencySymbol: hybgzsWelfareMoney.currencySymbol,
      quotaPerUnit: hybgzsWelfareMoney.quotaPerUnit,
      displayScale: hybgzsWelfareMoney.displayScale,
      lastError: null,
    })

    const config = await pageRequest<HybgzsWelfareCheckinConfig>(page, '/api/checkin/config', 'GET', {}, timeoutMs)
    this.noteAuthenticationResponse(config)
    if (!config.success) {
      const message = config.message || '无法读取黑与白福利站签到状态'
      const definitiveFailure = isDefinitiveAuthenticationFailure(config)
      return this.makeResult(site, runId, startedAt, definitiveFailure || isManualMessage(message) ? 'manual_required' : 'failed', message, {
        beforeRaw,
        money: hybgzsWelfareMoney,
        loginVerified: !definitiveFailure,
      })
    }
    if (config.data?.hasCheckedInToday) {
      return this.makeResult(site, runId, startedAt, 'already_checked', '今日已签到', {
        rewardRaw: numberOrNull(config.data.todayCheckinInfo?.rewardQuota),
        beforeRaw,
        afterRaw: beforeRaw,
        money: hybgzsWelfareMoney,
        loginVerified: true,
      })
    }

    const status = await pageRequest<HybgzsWelfareCheckinStatus>(page, '/api/checkin/status', 'GET', {}, timeoutMs)
    this.noteAuthenticationResponse(status)
    if (!status.success) {
      const message = status.message || '无法读取黑与白福利站签到配置'
      const definitiveFailure = isDefinitiveAuthenticationFailure(status)
      return this.makeResult(site, runId, startedAt, definitiveFailure || isManualMessage(message) ? 'manual_required' : 'failed', message, {
        beforeRaw,
        money: hybgzsWelfareMoney,
        loginVerified: !definitiveFailure,
      })
    }
    if (status.data?.enabled === false) {
      return this.makeResult(site, runId, startedAt, 'disabled', '签到功能未启用', { beforeRaw, afterRaw: beforeRaw, money: hybgzsWelfareMoney, loginVerified: true })
    }
    const signInButton = page.getByRole('button', { name: /立即签到/ })
    if (await signInButton.count() === 0) {
      return this.makeResult(site, runId, startedAt, 'failed', '签到页面未找到“立即签到”按钮', {
        beforeRaw,
        money: hybgzsWelfareMoney,
        loginVerified: true,
      })
    }

    await signInButton.click()
    // 保持前台页面：普通可点击验证会自动尝试，站点拒绝时仍可由用户完成。
    // 测试替身没有 bringToFront，由请求超时控制轮询，避免测试等待前台交互。
    const interactionTimeoutMs = typeof page.bringToFront === 'function' ? Math.max(timeoutMs, 5 * 60_000) : timeoutMs
    const deadline = Date.now() + interactionTimeoutMs
    let pageState: HybgzsWelfarePageState = { signed: false, challengeVisible: false, errorMessage: null }
    let verificationClickAttempts = 0
    let nextVerificationClickAt = 0
    while (Date.now() < deadline) {
      pageState = await readHybgzsWelfarePageState(page)
      if (pageState.signed) {
        const afterConfig = await pageRequest<HybgzsWelfareCheckinConfig>(page, '/api/checkin/config', 'GET', {}, timeoutMs)
        const afterRaw = await this.readHybgzsWelfareBalance(page, timeoutMs)
        return this.makeResult(site, runId, startedAt, 'success', '签到成功', {
          rewardRaw: numberOrNull(afterConfig.data?.todayCheckinInfo?.rewardQuota ?? afterConfig.data?.todayExpectedReward),
          beforeRaw,
          afterRaw,
          money: hybgzsWelfareMoney,
          loginVerified: true,
        })
      }
      if (pageState.errorMessage) {
        const loginVerified = !isLoginRelatedMessage(pageState.errorMessage)
        return this.makeResult(site, runId, startedAt, isManualMessage(pageState.errorMessage) ? 'manual_required' : 'failed', pageState.errorMessage, {
          beforeRaw,
          money: hybgzsWelfareMoney,
          loginVerified,
        })
      }
      if (pageState.challengeVisible && verificationClickAttempts < 3 && Date.now() >= nextVerificationClickAt) {
        verificationClickAttempts += 1
        nextVerificationClickAt = Date.now() + 1_500
        if (typeof page.bringToFront === 'function') await page.bringToFront().catch(() => undefined)
        await clickHybgzsWelfareVerification(page)
      }
      await page.waitForTimeout(500)
    }

    return this.makeResult(
      site,
      runId,
      startedAt,
      pageState.challengeVisible || status.data?.capRequired ? 'manual_required' : 'failed',
      pageState.challengeVisible
        ? '登录有效；请在打开的签到页面完成 CAP 人机验证，验证后会自动签到'
        : '点击“立即签到”后未收到签到结果，请打开签到页面检查',
      { beforeRaw, money: hybgzsWelfareMoney, loginVerified: true },
    )
  }

  private async detectHybgzsWelfareAuthentication(page: Page, timeoutMs = 30_000): Promise<HybgzsWelfareUserInfo | null> {
    this.beginAuthenticationProbe()
    const response = await pageRequest<HybgzsWelfareUserInfo>(page, '/api/user/info', 'GET', {}, timeoutMs)
    this.noteAuthenticationResponse(response)
    if (!response.success || !response.data?.user?.id) return null
    return response.data
  }

  private async readHybgzsWelfareBalance(page: Page, timeoutMs: number): Promise<number | null> {
    const mainSiteResponse = await pageRequest<HybgzsWelfareMainSiteBalance>(
      page,
      '/api/wallet/mainsite-balance?force=1',
      'GET',
      {},
      timeoutMs,
    )
    const mainSiteBalance = mainSiteResponse.success ? numberOrNull(mainSiteResponse.data?.balance) : null
    if (mainSiteBalance !== null) return mainSiteBalance

    const response = await pageRequest<HybgzsWelfareBalance>(page, '/api/wallet/balance', 'GET', {}, timeoutMs)
    if (!response.success) return null
    return numberOrNull(response.data?.mainSite?.balance ?? response.data?.total ?? response.data?.wallet?.balance)
  }

  private async readFengwindMainSiteBalance(page: Page, timeoutMs: number): Promise<number | null> {
    try {
      await page.goto(fengwindMainSiteUrl, { waitUntil: 'domcontentloaded' })
      const auth = await this.detectSub2ApiAuthentication(page, timeoutMs)
      return numberOrNull(auth?.user.balance)
    } catch {
      return null
    }
  }

  private async checkinChyTrafficSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
  ): Promise<CheckinResult> {
    const before = await readChyTrafficPage(page)
    if (!before.authenticated) {
      return this.authenticationRequiredResult(site, runId, startedAt, { money: chyTrafficMoney })
    }

    const beforeRemaining = before.stats.remaining
    if (beforeRemaining === null) {
      return this.makeResult(site, runId, startedAt, 'failed', '无法读取站点剩余流量', { money: chyTrafficMoney })
    }
    if (!before.claim) {
      return this.makeResult(site, runId, startedAt, 'already_checked', before.alreadyClaimed ? '今日已领取流量' : '今日暂无可领取流量', {
        beforeRaw: beforeRemaining,
        afterRaw: beforeRemaining,
        money: chyTrafficMoney,
      })
    }

    const claimUrl = new URL(before.claim.href, site.baseUrl)
    if (claimUrl.origin !== new URL(site.baseUrl).origin) {
      return this.makeResult(site, runId, startedAt, 'failed', '站点返回了无效的流量领取地址', {
        beforeRaw: beforeRemaining,
        money: chyTrafficMoney,
      })
    }
    await page.goto(claimUrl.toString(), { waitUntil: 'domcontentloaded' })
    const challenge = await detectChallenge(page)
    if (challenge) {
      return this.makeResult(site, runId, startedAt, 'manual_required', challenge, {
        beforeRaw: beforeRemaining,
        money: chyTrafficMoney,
        loginVerified: this.loginRemainsValid(site),
      })
    }

    const after = await readChyTrafficPage(page)
    if (!after.authenticated) {
      return this.makeResult(site, runId, startedAt, 'manual_required', '领取后登录状态失效，请重新授权', {
        beforeRaw: beforeRemaining,
        money: chyTrafficMoney,
      })
    }
    const afterRemaining = after.stats.remaining
    if (afterRemaining === null) {
      return this.makeResult(site, runId, startedAt, 'failed', '领取后无法读取剩余流量', {
        beforeRaw: beforeRemaining,
        money: chyTrafficMoney,
      })
    }
    const reward = roundAmount(Math.max(0, afterRemaining - beforeRemaining))
    if (reward <= 0) {
      return this.makeResult(site, runId, startedAt, 'already_checked', '今日已领取流量', {
        beforeRaw: beforeRemaining,
        afterRaw: afterRemaining,
        money: chyTrafficMoney,
      })
    }
    return this.makeResult(site, runId, startedAt, 'success', `成功领取 ${reward.toLocaleString('zh-CN')} GB`, {
      rewardRaw: reward,
      beforeRaw: beforeRemaining,
      afterRaw: afterRemaining,
      money: chyTrafficMoney,
    })
  }

  private async checkinPageTriggeredSite(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    await page.waitForTimeout(10_000)
    const statusResponse = await this.getRemoteStatus(page, timeoutMs)
    const auth = await this.detectAuthentication(page, site.legacyUserId, timeoutMs)
    if (!auth || auth.adapter === 'local-api') {
      return this.authenticationRequiredResult(site, runId, startedAt)
    }

    const money = deriveMoneySettings(statusResponse.data)
    const afterUser = isAnyRouterSite(site.baseUrl)
      ? await this.readAnyRouterUser(page, auth, timeoutMs)
      : await pageRequest<RemoteUser>(page, '/api/user/self', 'GET', buildAuthHeaders(auth), timeoutMs)
    this.noteAuthenticationResponse(afterUser)
    if (!afterUser.success) {
      const message = afterUser.message || '页面打开后无法读取当前余额'
      const definitiveFailure = isDefinitiveAuthenticationFailure(afterUser)
      return this.makeResult(site, runId, startedAt, definitiveFailure ? 'manual_required' : 'failed', message, {
        beforeRaw: site.lastBalanceRaw,
        money,
        loginVerified: !definitiveFailure,
      })
    }

    const beforeRaw = site.lastBalanceRaw
    const normalizedAfterUser = normalizeNewApiUser(afterUser.data)
    const afterRaw = normalizedAfterUser ? newApiUserBalance(normalizedAfterUser) : numberOrNull(afterUser.data?.quota)
    const rewardRaw = beforeRaw !== null && afterRaw !== null && afterRaw > beforeRaw
      ? afterRaw - beforeRaw
      : null
    return this.makeResult(
      site,
      runId,
      startedAt,
      rewardRaw === null ? 'already_checked' : 'success',
      rewardRaw === null ? '页面已打开，今日自动签到已触发' : '页面自动签到成功',
      { rewardRaw, beforeRaw, afterRaw, money },
    )
  }

  private async readAnyRouterUser(
    page: Page,
    auth: RemoteAuth,
    timeoutMs: number,
  ): Promise<RemoteResponse<RemoteUser>> {
    const cookieResponse = await pageRequest<RemoteUser>(page, '/api/user/self', 'GET', {}, timeoutMs)
    if (cookieResponse.success) {
      const cookieUser = normalizeNewApiUser(cookieResponse.data)
      if (cookieUser && (newApiUserBalance(cookieUser) ?? 0) > 0) return cookieResponse
    }
    const tokenResponse = await pageRequest<RemoteUser>(page, '/api/user/self', 'GET', buildAuthHeaders(auth), timeoutMs)
    if (tokenResponse.success) {
      const tokenUser = normalizeNewApiUser(tokenResponse.data)
      if (tokenUser && (newApiUserBalance(tokenUser) ?? 0) > 0) return tokenResponse
    }
    return cookieResponse.success ? cookieResponse : tokenResponse
  }

  private async getRemoteStatus(page: Page, timeoutMs = 30_000): Promise<RemoteResponse<RemoteStatus>> {
    return pageRequest<RemoteStatus>(page, '/api/status', 'GET', {}, timeoutMs)
  }

  private async refreshYiApiBalance(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    const auth = await this.detectYiApiAuthentication(page, timeoutMs)
    if (!auth) {
      return this.authenticationRequiredResult(site, runId, startedAt, {
        beforeRaw: site.lastBalanceRaw,
        money: yiApiMoney,
      })
    }

    const balance = numberOrNull(auth.user.balance ?? auth.user.quota)
    if (balance === null) {
      return this.makeResult(site, runId, startedAt, 'failed', '无法读取 YiAPI 余额', {
        beforeRaw: site.lastBalanceRaw,
        money: yiApiMoney,
        loginVerified: true,
      })
    }

    this.db.updateSiteAuth(site.id, {
      adapter: 'new-api-modern',
      authStatus: 'valid',
      baseUrl: site.baseUrl,
      username: auth.user.display_name || auth.user.username || null,
      currencySymbol: yiApiMoney.currencySymbol,
      quotaPerUnit: yiApiMoney.quotaPerUnit,
      displayScale: yiApiMoney.displayScale,
      lastBalanceRaw: balance,
      lastBalanceAmount: quotaToAmount(balance, yiApiMoney.quotaPerUnit, yiApiMoney.displayScale),
      lastError: null,
    })
    return this.makeResult(site, runId, startedAt, 'disabled', 'YiAPI 未提供签到接口，余额已刷新', {
      beforeRaw: site.lastBalanceRaw,
      afterRaw: balance,
      money: yiApiMoney,
      loginVerified: true,
    })
  }

  private async refreshTrueSotaBalance(
    page: Page,
    site: Site,
    runId: number,
    startedAt: string,
    timeoutMs: number,
  ): Promise<CheckinResult> {
    const beforeRaw = site.lastBalanceRaw
    const auth = await this.detectTrueSotaAuthentication(page, timeoutMs)
    if (!auth) {
      return this.authenticationRequiredResult(site, runId, startedAt, {
        beforeRaw,
        money: trueSotaMoney,
      })
    }

    const balance = numberOrNull(auth.user.balance ?? auth.user.quota)
    if (balance === null) {
      return this.makeResult(site, runId, startedAt, 'failed', '无法读取 TrueSOTA 余额', {
        beforeRaw,
        money: trueSotaMoney,
        loginVerified: true,
      })
    }

    this.db.updateSiteAuth(site.id, {
      adapter: 'sub2api',
      authStatus: 'valid',
      baseUrl: site.baseUrl,
      username: auth.user.display_name || auth.user.username || null,
      currencySymbol: trueSotaMoney.currencySymbol,
      quotaPerUnit: trueSotaMoney.quotaPerUnit,
      displayScale: trueSotaMoney.displayScale,
      lastBalanceRaw: balance,
      lastBalanceAmount: quotaToAmount(balance, trueSotaMoney.quotaPerUnit, trueSotaMoney.displayScale),
      lastError: null,
    })
    return this.makeResult(site, runId, startedAt, 'disabled', 'TrueSOTA 未提供签到接口，余额已刷新', {
      beforeRaw,
      afterRaw: balance,
      money: trueSotaMoney,
      loginVerified: true,
    })
  }

  private getCachedModernAccessToken(siteId: number): ModernAccessToken | null {
    const cached = this.modernAccessTokens.get(siteId)
    if (!cached) return null
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now() + 10_000) {
      this.modernAccessTokens.delete(siteId)
      return null
    }
    return cached
  }

  private rememberModernAccessToken(siteId: number, token: ModernAccessToken | null): void {
    if (!token?.token) return
    this.modernAccessTokens.set(siteId, {
      ...token,
      expiresAt: token.expiresAt ?? Date.now() + 5 * 60_000,
    })
  }

  async verifySnapshotLogin(site: Site, snapshot: BrowserAuthSnapshot): Promise<boolean> {
    return this.browser.run({
      interactive: false,
      closeBrowserWhenDone: true,
      timeoutMs: Math.max(30_000, this.siteOperationTimeoutMs()),
    }, async (context, page) => {
      try {
        if (snapshot.cookies.length) await context.addCookies(snapshot.cookies)
        await this.installImportedStorage(page, site, snapshot)
        await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await page.waitForTimeout(1_000)
        const auth = await this.detectAuthentication(page, site.legacyUserId, 30_000)
        if (auth?.adapter === 'new-api-modern' && auth.accessToken) {
          try {
            const host = new URL(site.baseUrl).hostname.toLowerCase().replace(/\.$/, '')
            this.authAssistant?.updateSnapshotLocalStorage(site.id, host, { auth_token: auth.accessToken })
          } catch {
            // A stale snapshot is not fatal; balance refresh can still retry.
          }
        }
        return Boolean(auth?.user && (
          Number(auth.user.id ?? auth.legacyUserId) > 0
          || Boolean(auth.user.username)
          || Boolean(auth.user.display_name)
        ))
      } catch {
        return false
      }
    })
  }

  private async tryReadNewApiBalanceWithoutPage(
    context: BrowserContext,
    site: Site,
    timeoutMs: number,
  ): Promise<
    | { kind: 'success'; read: NewApiBalanceRead; money: ReturnType<typeof deriveMoneySettings> }
    | { kind: 'auth_failed'; money: ReturnType<typeof deriveMoneySettings> }
    | { kind: 'skip' }
  > {
    if (!(context as { request?: { fetch?: unknown } }).request?.fetch) return { kind: 'skip' }
    const statusResponse = await contextRequest<RemoteStatus>(context, site.baseUrl, '/api/status', 'GET', {}, timeoutMs)
    if (!statusResponse.success || statusResponse.data?.checkin_enabled !== false) return { kind: 'skip' }
    const money = deriveMoneySettings(statusResponse.data)
    const snapshot = await this.authAssistant?.getSnapshot(site.id) ?? null
    const token = snapshot ? readSnapshotAccessToken(snapshot) : null

    const readWithToken = async (accessToken: string): Promise<NewApiBalanceRead | null> => {
      const self = await contextRequest<unknown>(
        context,
        site.baseUrl,
        '/api/user/self',
        'GET',
        { Authorization: `Bearer ${accessToken}` },
        timeoutMs,
      )
      this.noteAuthenticationResponse(self)
      const user = self.success ? normalizeNewApiUser(self.data) : null
      const balance = user ? newApiUserBalance(user) : null
      return balance === null || !user ? null : { auth: { adapter: 'new-api-modern', accessToken, user }, balance }
    }

    if (token) {
      const read = await readWithToken(token)
      if (read) return { kind: 'success', read, money }
    }

    const refresh = await contextRequest<{ access_token?: string }>(
      context,
      site.baseUrl,
      '/api/user/auth/refresh',
      'POST',
      {},
      timeoutMs,
    )
    if (refresh.success && typeof refresh.data?.access_token === 'string' && refresh.data.access_token.trim()) {
      const refreshedToken = refresh.data.access_token.trim().replace(/^Bearer\s+/i, '')
      try {
        const host = new URL(site.baseUrl).hostname.toLowerCase().replace(/\.$/, '')
        this.authAssistant?.updateSnapshotLocalStorage(site.id, host, { auth_token: refreshedToken })
      } catch {
        // Keep the token in memory for this read even if the snapshot is stale.
      }
      const read = await readWithToken(refreshedToken)
      if (read) return { kind: 'success', read, money }
    }
    return { kind: 'auth_failed', money }
  }

  private async readNewApiBalanceWithoutRefresh(
    page: Page,
    site: Site,
    timeoutMs: number,
    observer?: ModernAccessTokenObserver,
  ): Promise<NewApiBalanceRead | null> {
    const readAuthenticatedBalance = async (auth: RemoteAuth): Promise<NewApiBalanceRead | null> => {
      const authenticated = await pageRequest<unknown>(page, '/api/user/self', 'GET', buildAuthHeaders(auth), timeoutMs)
      this.noteAuthenticationResponse(authenticated)
      if (!authenticated.success) return null
      const user = normalizeNewApiUser(authenticated.data)
      if (!user) return null
      const balance = newApiUserBalance(user)
      return balance === null ? null : { auth: { ...auth, user }, balance }
    }

    // Any Router's New API frontend reads the same endpoint with its browser
    // session. A bearer token copied from localStorage can be accepted while
    // still resolving to the public/default user (quota 0), so prefer the
    // cookie-backed response and only fall back to token auth when necessary.
    const preferBrowserSession = isAnyRouterSite(site.baseUrl)
    let cookieBalance: NewApiBalanceRead | null = null
    let cookieBalanceAttempted = false
    if (preferBrowserSession) {
      cookieBalanceAttempted = true
      cookieBalance = await readAuthenticatedBalance({ adapter: 'new-api-modern', user: {} })
      if (cookieBalance && isTrustedAnyRouterBalance(site, cookieBalance)) return cookieBalance

      // The console hydrates its cookie-backed session asynchronously. A cold
      // production browser can briefly receive the public user's quota (zero)
      // before the same page has restored the signed-in session.
      if (cookieBalance) {
        await page.waitForTimeout(800).catch(() => undefined)
        const settledCookieBalance = await readAuthenticatedBalance({ adapter: 'new-api-modern', user: {} })
        if (settledCookieBalance) cookieBalance = settledCookieBalance
        if (settledCookieBalance && isTrustedAnyRouterBalance(site, settledCookieBalance)) return settledCookieBalance
      }
    }

    try {
      const storedAccessToken = await readNewApiAccessToken(page)
      if (storedAccessToken) {
        const storedAuth: RemoteAuth = { adapter: 'new-api-modern', accessToken: storedAccessToken, user: {} }
        const storedBalance = await readAuthenticatedBalance(storedAuth)
        if (storedBalance && (!preferBrowserSession || isTrustedAnyRouterBalance(site, storedBalance))) {
          this.rememberModernAccessToken(site.id, { token: storedAccessToken, expiresAt: null })
          return storedBalance
        }
      }

      const captured = await observer?.waitForToken(timeoutMs) ?? null
      this.rememberModernAccessToken(site.id, captured)
      if (captured && captured.token !== storedAccessToken) {
        const capturedBalance = await readAuthenticatedBalance({
          adapter: 'new-api-modern',
          accessToken: captured.token,
          user: {},
        })
        if (capturedBalance && (!preferBrowserSession || isTrustedAnyRouterBalance(site, capturedBalance))) return capturedBalance
      }
    } finally {
      observer?.dispose()
    }

    // A few older deployments accept the refresh cookie directly for this
    // read. It is safe to try because this is a GET and never rotates it.
    if (!cookieBalanceAttempted) {
      cookieBalanceAttempted = true
      cookieBalance = await readAuthenticatedBalance({ adapter: 'new-api-modern', user: {} })
    }
    if (cookieBalance && (!preferBrowserSession || isTrustedAnyRouterBalance(site, cookieBalance))) return cookieBalance

    // Legacy New API installations can still identify the user without the
    // modern refresh endpoint. Explicitly disable modern auth detection here.
    const legacyAuth = await this.detectAuthentication(page, site.legacyUserId, timeoutMs, false)
    if (!legacyAuth) return null
    const legacyBalance = newApiUserBalance(legacyAuth.user)
    if (legacyBalance !== null) {
      const legacyRead = { auth: legacyAuth, balance: legacyBalance }
      return !preferBrowserSession || isTrustedAnyRouterBalance(site, legacyRead) ? legacyRead : null
    }
    const legacyRead = await readAuthenticatedBalance(legacyAuth)
    return !preferBrowserSession || !legacyRead || isTrustedAnyRouterBalance(site, legacyRead) ? legacyRead : null
  }

  private persistNewApiBalance(
    site: Site,
    balanceRead: NewApiBalanceRead,
    money: ReturnType<typeof deriveMoneySettings>,
  ): void {
    this.db.updateSiteAuth(site.id, {
      adapter: balanceRead.auth.adapter,
      authStatus: 'valid',
      baseUrl: site.baseUrl,
      username: balanceRead.auth.user.display_name || balanceRead.auth.user.username || null,
      legacyUserId: balanceRead.auth.legacyUserId ?? numberOrNull(balanceRead.auth.user.id) ?? site.legacyUserId,
      currencySymbol: money.currencySymbol,
      quotaPerUnit: money.quotaPerUnit,
      displayScale: money.displayScale,
      lastBalanceRaw: balanceRead.balance,
      lastBalanceAmount: quotaToAmount(balanceRead.balance, money.quotaPerUnit, money.displayScale),
      lastError: null,
    })
  }

  private async detectAuthentication(
    page: Page,
    knownLegacyUserId?: number | null,
    timeoutMs = 30_000,
    allowModern = true,
    observedLegacyUserIds: Iterable<number> = [],
  ): Promise<RemoteAuth | null> {
    this.beginAuthenticationProbe()
    const localApiToken = await page.evaluate(() => localStorage.getItem('localapi_user_token')).catch(() => null)
    if (typeof localApiToken === 'string' && localApiToken) {
      const response = await pageRequest<RemoteUser | { user?: RemoteUser }>(page, '/user/api/me', 'GET', { 'x-user-token': localApiToken }, timeoutMs)
      this.noteAuthenticationResponse(response)
      if (response.success && response.data) {
        const payload = response.data as RemoteUser & { user?: RemoteUser }
        const user = payload.user ?? payload
        return { adapter: 'local-api', sessionToken: localApiToken, user }
      }
    }

    if (allowModern) {
      const storedAccessToken = await readNewApiAccessToken(page)
      if (storedAccessToken) {
        const self = await pageRequest<unknown>(
          page,
          '/api/user/self',
          'GET',
          { Authorization: `Bearer ${storedAccessToken}` },
          timeoutMs,
        )
        this.noteAuthenticationResponse(self)
        const user = self.success ? normalizeNewApiUser(self.data) : null
        if (user) return { adapter: 'new-api-modern', accessToken: storedAccessToken, user }
      }
    }

    const candidateIds = new Set<number>()
    if (knownLegacyUserId) candidateIds.add(knownLegacyUserId)
    for (const observedUserId of observedLegacyUserIds) candidateIds.add(observedUserId)
    const storedLegacyUserId = await readNewApiLegacyUserId(page)
    if (storedLegacyUserId !== null) candidateIds.add(storedLegacyUserId)
    const discovered = await page.evaluate(() => {
      const ids: number[] = []
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (!key) continue
        const value = localStorage.getItem(key)
        if (!value || value.length > 100_000) continue
        try {
          const parsed = JSON.parse(value)
          const candidates = [parsed, parsed?.user, parsed?.state?.user, parsed?.data]
          for (const candidate of candidates) {
            const id = Number(candidate?.id)
            if (Number.isInteger(id) && id > 0) ids.push(id)
          }
        } catch {
          // Non-JSON storage values are irrelevant to New API identity.
        }
      }
      return [...new Set(ids)].slice(0, 10)
    }).catch(() => [] as number[])
    for (const id of discovered) candidateIds.add(id)

    for (const userId of candidateIds) {
      const self = await pageRequest<RemoteUser>(page, '/api/user/self', 'GET', { 'New-API-User': String(userId) }, timeoutMs)
      this.noteAuthenticationResponse(self)
      if (self.success && Number(self.data?.id) > 0) {
        return { adapter: 'new-api-legacy', legacyUserId: userId, user: self.data! }
      }
    }

    if (!allowModern) return null
    const modern = await pageRequest<{
      access_token?: string
      user?: RemoteUser
    }>(page, '/api/user/auth/refresh', 'POST', {}, timeoutMs)
    this.noteAuthenticationResponse(modern)
    if (modern.success && modern.data?.access_token && modern.data.user) {
      return { adapter: 'new-api-modern', accessToken: modern.data.access_token, user: modern.data.user }
    }
    return null
  }

  private async detectYiApiAuthentication(page: Page, timeoutMs = 30_000): Promise<RemoteAuth | null> {
    this.beginAuthenticationProbe()
    const accessToken = await readYiApiAccessToken(page)
    if (!accessToken) return null
    const headers = { Authorization: `Bearer ${accessToken}` }
    for (const pathname of ['/api/v1/user/profile', '/api/v1/auth/me']) {
      const response = await pageRequest<unknown>(page, pathname, 'GET', headers, timeoutMs)
      this.noteAuthenticationResponse(response)
      if (!response.success) continue
      const user = normalizeYiApiUser(response.data)
      if (!user) continue
      return { adapter: 'new-api-modern', accessToken, user }
    }
    return null
  }

  private async detectTrueSotaAuthentication(page: Page, timeoutMs = 30_000): Promise<RemoteAuth | null> {
    this.beginAuthenticationProbe()
    let accessToken = await readSub2ApiToken(page, 'access')
    const readUser = async (): Promise<RemoteAuth | null> => {
      if (!accessToken) return null
      const headers = { Authorization: `Bearer ${accessToken}` }
      for (const pathname of ['/api/v1/auth/me', '/api/v1/user/profile']) {
        const response = await pageRequest<unknown>(page, pathname, 'GET', headers, timeoutMs)
        this.noteAuthenticationResponse(response)
        if (!response.success) continue
        const user = normalizeYiApiUser(response.data)
        if (!user) continue
        return { adapter: 'sub2api', accessToken, user }
      }
      return null
    }

    const authenticated = await readUser()
    if (authenticated) return authenticated

    const refreshToken = await readSub2ApiToken(page, 'refresh')
    if (!refreshToken) return null
    const refreshed = await pageRequest<{ access_token?: string; token?: string }>(
      page,
      '/api/v1/auth/refresh',
      'POST',
      { 'Content-Type': 'application/json' },
      timeoutMs,
      JSON.stringify({ refresh_token: refreshToken }),
    )
    this.noteAuthenticationResponse(refreshed)
    const refreshedToken = refreshed.success ? (refreshed.data?.access_token || refreshed.data?.token) : null
    if (!refreshedToken) return null
    accessToken = refreshedToken
    await page.evaluate((token) => localStorage.setItem('auth_token', token), accessToken).catch(() => undefined)
    return readUser()
  }

  private async detectSub2ApiAuthentication(
    page: Page,
    timeoutMs = 30_000,
    site?: Pick<Site, 'id' | 'baseUrl'>,
  ): Promise<{ accessToken: string; user: Sub2ApiUser } | null> {
    this.beginAuthenticationProbe()
    let activeToken = await readSub2ApiToken(page, 'access')

    const readUser = async () => {
      let lastResponse: RemoteResponse<unknown> | null = null
      let authenticatedWithoutBalance: { response: RemoteResponse<unknown>; user: Sub2ApiUser } | null = null
      let unauthorized = false
      for (const pathname of ['/api/v1/auth/me', '/api/v1/user/profile']) {
        const response = await pageRequest<unknown>(
          page,
          pathname,
          'GET',
          { Authorization: `Bearer ${activeToken}` },
          timeoutMs,
        )
        this.noteAuthenticationResponse(response)
        lastResponse = response
        if (response.httpStatus === 401) unauthorized = true
        if (!response.success) continue
        const user = normalizeSub2ApiUser(response.data)
        if (!user) continue
        if (numberOrNull(user.balance ?? user.quota) !== null) return { response, user, unauthorized }
        authenticatedWithoutBalance ??= { response, user }
      }
      return { response: lastResponse, user: authenticatedWithoutBalance?.user ?? null, unauthorized }
    }

    const readCookieUser = async (): Promise<Sub2ApiUser | null> => {
      for (const pathname of ['/api/v1/auth/me', '/api/v1/user/profile']) {
        const response = await pageRequest<unknown>(page, pathname, 'GET', {}, timeoutMs)
        this.noteAuthenticationResponse(response)
        if (!response.success) continue
        const user = normalizeSub2ApiUser(response.data)
        if (user) return user
      }
      return null
    }

    if (!activeToken) {
      const cookieUser = await readCookieUser()
      return cookieUser ? { accessToken: '', user: cookieUser } : null
    }

    let authenticated = await readUser()
    if (authenticated.unauthorized || (!authenticated.user && authenticated.response?.httpStatus === 401)) {
      const cookieUser = await readCookieUser()
      if (cookieUser && numberOrNull(cookieUser.balance ?? cookieUser.quota) !== null) {
        // Prefer the imported browser session over a token refresh. Some
        // Sub2API deployments rotate or revoke the old refresh token, which can
        // also invalidate the cookie session on the next balance refresh.
        this.beginAuthenticationProbe()
        return { accessToken: '', user: cookieUser }
      }
      const refreshToken = await readSub2ApiToken(page, 'refresh')
      if (refreshToken) {
        const refreshed = await pageRequest<{ access_token?: string; refresh_token?: string }>(
          page,
          '/api/v1/auth/refresh',
          'POST',
          { 'Content-Type': 'application/json' },
          timeoutMs,
          JSON.stringify({ refresh_token: refreshToken }),
        )
        this.noteAuthenticationResponse(refreshed)
        if (refreshed.success && refreshed.data?.access_token) {
          activeToken = refreshed.data.access_token
          await page.evaluate(({ accessToken, refreshToken: nextRefreshToken }) => {
            localStorage.setItem('auth_token', accessToken)
            if (nextRefreshToken) localStorage.setItem('refresh_token', nextRefreshToken)
          }, { accessToken: activeToken, refreshToken: refreshed.data.refresh_token ?? null }).catch(() => undefined)
          if (site) {
            const host = new URL(site.baseUrl).hostname.toLowerCase().replace(/\.$/, '')
            const values: Record<string, string> = { auth_token: activeToken }
            if (refreshed.data.refresh_token) values.refresh_token = refreshed.data.refresh_token
            this.authAssistant?.updateSnapshotLocalStorage(site.id, host, values)
          }
          this.beginAuthenticationProbe()
          authenticated = await readUser()
        }
      }
    }
    if (!authenticated.user) {
      const cookieUser = await readCookieUser()
      if (cookieUser) return { accessToken: '', user: cookieUser }
    }
    return authenticated.user ? { accessToken: activeToken, user: authenticated.user } : null
  }

  private async detectFengwindWelfareAuthentication(
    page: Page,
    timeoutMs = 30_000,
  ): Promise<{ accessToken: string; user: FengwindWelfareUser } | null> {
    this.beginAuthenticationProbe()
    const accessToken = await page.evaluate(() => localStorage.getItem('welfare_token')?.trim() || null).catch(() => null)
    if (!accessToken) return null
    const response = await pageRequest<FengwindWelfareUser>(
      page,
      '/api/me',
      'GET',
      { Authorization: `Bearer ${accessToken}` },
      timeoutMs,
    )
    this.noteAuthenticationResponse(response)
    return response.success && response.data
      ? { accessToken, user: response.data }
      : null
  }

}

function observeModernAccessToken(
  page: Page,
  baseUrl: string,
  initial: ModernAccessToken | null,
): ModernAccessTokenObserver {
  let captured = initial
  let resolveWait: ((token: ModernAccessToken | null) => void) | null = null

  const waitPromise = new Promise<ModernAccessToken | null>((resolve) => {
    resolveWait = resolve
  })

  const accept = (token: string, expiresAt: number | null) => {
    const normalized = token.replace(/^Bearer\s+/i, '').trim()
    if (!normalized) return
    captured = { token: normalized, expiresAt }
    resolveWait?.(captured)
    resolveWait = null
  }

  let origin = ''
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return {
      waitForToken: async () => captured,
      dispose: () => undefined,
    }
  }

  const isTargetApiRequest = (urlValue: string) => {
    try {
      const url = new URL(urlValue)
      return url.origin === origin && url.pathname.startsWith('/api/')
    } catch {
      return false
    }
  }

  const onRequest = (request: Request) => {
    if (!isTargetApiRequest(request.url())) return
    const authorization = request.headers().authorization
    if (typeof authorization === 'string' && /^Bearer\s+\S+/i.test(authorization)) {
      accept(authorization, null)
    }
  }

  const onResponse = (response: Response) => {
    if (!isTargetApiRequest(response.url())) return
    try {
      const url = new URL(response.url())
      if (url.pathname !== '/api/user/auth/refresh') return
    } catch {
      return
    }
    void response.json().then((payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const body = payload as { data?: unknown }
      const data = body.data && typeof body.data === 'object'
        ? body.data as Record<string, unknown>
        : payload as Record<string, unknown>
      const token = typeof data.access_token === 'string' ? data.access_token : ''
      if (!token) return
      accept(token, normalizeAccessTokenExpiry(data.access_expires_at))
    }).catch(() => undefined)
  }

  if (typeof page.on !== 'function') {
    return {
      waitForToken: async () => captured,
      dispose: () => undefined,
    }
  }

  page.on('request', onRequest)
  page.on('response', onResponse)
  return {
    async waitForToken(timeoutMs: number) {
      if (captured) return captured
      const waitMs = Math.min(Math.max(timeoutMs, 250), 5_000)
      return Promise.race([
        waitPromise,
        new Promise<ModernAccessToken | null>((resolve) => setTimeout(() => resolve(captured), waitMs)),
      ])
    },
    dispose() {
      if (typeof page.off === 'function') {
        page.off('request', onRequest)
        page.off('response', onResponse)
      }
      resolveWait?.(captured)
      resolveWait = null
    },
  }
}

async function pageRequest<T>(
  page: Page,
  pathname: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  timeoutMs = 30_000,
  body?: string,
): Promise<RemoteResponse<T>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await pageRequestOnce(page, pathname, method, headers, timeoutMs, body)
      if (raw && typeof raw === 'object' && 'success' in raw) return raw as RemoteResponse<T>
      const response = parseRemoteResponseBody<T>(raw)
      // Some New API forks serve the SPA shell for every path while the app is
      // still hydrating. Wait briefly and retry once instead of failing as if
      // the site were unavailable.
      if (!response.success && attempt === 0 && isSpaHtmlResponse(raw)) {
        await page.waitForTimeout(1_000)
        continue
      }
      return response
    } catch (error) {
      if (!isNavigationContextError(error) || attempt === 1) {
        return {
          httpStatus: 0,
          contentType: '',
          success: false,
          message: '站点页面正在跳转，请稍后重试',
        }
      }
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
  }
  return { httpStatus: 0, contentType: '', success: false, message: '站点页面正在跳转，请稍后重试' }
}

async function pageRequestOnce<T>(
  page: Page,
  pathname: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  timeoutMs = 30_000,
  body?: string,
): Promise<RemoteResponse<T>> {
  const raw = await page.evaluate(async ({ pathname, method, headers, timeoutMs, body }) => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const init: RequestInit = {
         method,
         credentials: 'include',
         headers: { Accept: 'application/json', ...headers },
         signal: controller.signal,
       }
       if (body !== undefined) init.body = body
       const response = await fetch(pathname, init)
      const contentType = response.headers.get('content-type') || ''
      return {
        httpStatus: response.status,
        contentType,
        body: await response.text(),
      }
    } catch (error) {
      return {
        httpStatus: 0,
        contentType: '',
        error: error instanceof Error ? error.message : '网络请求失败',
      }
    } finally {
      window.clearTimeout(timeout)
    }
  }, { pathname, method, headers, timeoutMs, body }) as RawRemoteResponse | RemoteResponse<T>
  // Lightweight browser fakes used by integration tests may return the
  // normalized response directly; keep that seam compatible while real pages
  // return the raw body above.
  if (raw && typeof raw === 'object' && 'success' in raw) return raw as RemoteResponse<T>
  return parseRemoteResponseBody<T>(raw)
}

function isNavigationContextError(error: unknown): boolean {
  return error instanceof Error && /execution context was destroyed|most likely because of a navigation|target closed/i.test(error.message)
}

function isSpaHtmlResponse(raw: RawRemoteResponse): boolean {
  const contentType = String(raw.contentType ?? '').toLowerCase()
  const body = String(raw.body ?? '')
  return contentType.includes('text/html')
    || contentType.includes('application/xhtml+xml')
    || /^\s*<!doctype\s+html/i.test(body)
    || /^\s*<html[\s>]/i.test(body)
    || /<div[^>]*(?:id=["'](?:root|app|__next)["'])/i.test(body)
}

async function contextRequest<T>(
  context: BrowserContext,
  baseUrl: string,
  pathname: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  timeoutMs = 30_000,
  body?: string,
): Promise<RemoteResponse<T>> {
  try {
    const response = await context.request.fetch(new URL(pathname, baseUrl).toString(), {
      method,
      headers: { Accept: 'application/json', ...headers },
      data: body,
      timeout: timeoutMs,
      failOnStatusCode: false,
    })
    const contentType = response.headers()['content-type'] || ''
    return parseRemoteResponseBody<T>({
      httpStatus: response.status(),
      contentType,
      body: await response.text(),
    })
  } catch (error) {
    return {
      httpStatus: 0,
      contentType: '',
      success: false,
      message: error instanceof Error ? error.message : '网络请求失败',
    }
  }
}

async function extractNewApiOfficialKeys(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<OfficialApiKeyCandidate[]> {
  const list = await firstSuccessfulAuthorizedRequest(page, context, baseUrl, [
    { pathname: '/api/token/?p=1&size=100', method: 'GET' },
    { pathname: '/api/token?p=1&size=100', method: 'GET' },
    { pathname: '/api/token/', method: 'GET' },
    { pathname: '/api/token', method: 'GET' },
    { pathname: '/api/token/?p=1&size=100', method: 'POST' },
    { pathname: '/api/token/?p=1&size=100&order=created_at', method: 'GET' },
  ], headers, timeoutMs)
  if (!list) return []
  const tokenEntries = collectTokenEntries(list.data).slice(0, 50)
  const candidates: OfficialApiKeyCandidate[] = []
  const directKeys = collectOfficialApiKeys(list.data)
  directKeys.forEach((key, index) => candidates.push({ id: `token-list-${index + 1}-${key.slice(-8)}`, name: `API Key ${index + 1}`, apiKey: key, keyLast4: key.slice(-4) }))

  // Current New API exposes a batch endpoint that returns the full keys while
  // the list endpoint intentionally returns masked values. Some deployments
  // expose the batch endpoint before the per-token endpoint, so try it first.
  const tokenIds = tokenEntries.map((token) => token.id)
  if (tokenIds.length) {
    const batch = await firstSuccessfulAuthorizedRequest(page, context, baseUrl, [
      { pathname: '/api/token/batch/keys', method: 'POST', body: JSON.stringify({ ids: tokenIds }) },
    ], headers, timeoutMs)
    if (batch) {
      const batchKeys = collectOfficialKeyMap(batch.data)
      for (const token of tokenEntries) {
        const key = batchKeys.get(token.id)
        if (!key) continue
        candidates.push({ id: `token-${token.id}-${key.slice(-8)}`, name: token.name || `API Key ${token.id}`, apiKey: key, keyLast4: key.slice(-4) })
      }
    }
  }

  for (const token of tokenEntries) {
    const response = await firstSuccessfulAuthorizedRequest(page, context, baseUrl, [
      { pathname: `/api/token/${token.id}/key`, method: 'POST' },
      { pathname: `/api/token/${token.id}/key/`, method: 'POST' },
      { pathname: `/api/token/${token.id}/key`, method: 'GET' },
      { pathname: `/api/token/${token.id}`, method: 'GET' },
    ], headers, timeoutMs)
    if (!response) continue
    for (const key of collectOfficialApiKeys(response.data)) {
      candidates.push({ id: `token-${token.id}-${key.slice(-8)}`, name: token.name || `API Key ${token.id}`, apiKey: key, keyLast4: key.slice(-4) })
    }
  }
  return dedupeOfficialApiKeyCandidates(candidates)
}

async function extractSub2ApiOfficialKeys(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<OfficialApiKeyCandidate[]> {
  const endpoints = [
    '/api/v1/api-keys',
    '/api/v1/api_keys',
    '/api/v1/user/api-keys',
    '/api/v1/user/api_keys',
    '/api/v1/keys',
    '/api/keys',
  ]
  const candidates: OfficialApiKeyCandidate[] = []
  for (const endpoint of endpoints) {
    const list = await firstSuccessfulAuthorizedRequest(page, context, baseUrl, [
      { pathname: endpoint, method: 'GET' },
      { pathname: `${endpoint}/`, method: 'GET' },
      { pathname: endpoint, method: 'POST' },
    ], headers, timeoutMs)
    if (!list) continue
    const entries = collectTokenEntries(list.data).slice(0, 50)
    const direct = collectOfficialApiKeys(list.data)
    direct.forEach((key, index) => candidates.push({ id: `key-${index + 1}`, name: `API Key ${index + 1}`, apiKey: key, keyLast4: key.slice(-4) }))
    for (const entry of entries) {
      const id = entry.id
      for (const suffix of [`/${id}`, `/${id}/key`]) {
        const response = await firstSuccessfulAuthorizedRequest(page, context, baseUrl, [
          { pathname: `${endpoint}${suffix}`, method: 'GET' },
          { pathname: `${endpoint}${suffix}/`, method: 'GET' },
          { pathname: `${endpoint}${suffix}`, method: 'POST' },
        ], headers, timeoutMs)
        if (!response) continue
        for (const key of collectOfficialApiKeys(response.data)) {
          candidates.push({ id: `key-${id}-${key.slice(-8)}`, name: entry.name || `API Key ${id}`, apiKey: key, keyLast4: key.slice(-4) })
        }
      }
    }
  }
  return dedupeOfficialApiKeyCandidates(candidates)
}

async function firstSuccessfulContextRequest(
  context: BrowserContext,
  baseUrl: string,
  requests: Array<{ pathname: string; method: 'GET' | 'POST'; body?: string }>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RemoteResponse<unknown> | null> {
  for (const request of requests) {
    const response = await contextRequest<unknown>(context, baseUrl, request.pathname, request.method, headers, timeoutMs, request.body)
    if (response.success) return response
  }
  return null
}

async function firstSuccessfulAuthorizedRequest(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  requests: Array<{ pathname: string; method: 'GET' | 'POST'; body?: string }>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RemoteResponse<unknown> | null> {
  for (const request of requests) {
    // A page fetch preserves the site's cookie session and automatically sends
    // the expected same-origin headers. This matters for New API installations
    // with SessionCookieOriginGuard enabled.
    const pageResponse = await pageRequest<unknown>(page, request.pathname, request.method, headers, timeoutMs, request.body)
    if (pageResponse.success) return pageResponse

    // Keep the APIRequestContext fallback for deployments where the page has a
    // restrictive CSP or the endpoint is available only outside the SPA shell.
    const contextResponse = await contextRequest<unknown>(context, baseUrl, request.pathname, request.method, headers, timeoutMs, request.body)
    if (contextResponse.success) return contextResponse
  }
  return null
}

interface OfficialApiKeyEntry {
  id: number
  name: string | null
}

function collectTokenEntries(value: unknown, depth = 0): OfficialApiKeyEntry[] {
  if (depth > 7 || value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((item) => collectTokenEntries(item, depth + 1))
  if (typeof value !== 'object') return []
  const entries: OfficialApiKeyEntry[] = []
  for (const [property, child] of Object.entries(value)) {
    if (/^(?:id|token_id|tokenId)$/.test(property)) {
      const id = Number(child)
      if (Number.isInteger(id) && id > 0) {
        const record = value as Record<string, unknown>
        const name = [record.name, record.token_name, record.tokenName, record.key_name, record.keyName].find((item): item is string => typeof item === 'string' && item.trim().length > 0)
        entries.push({ id, name: name?.trim() ?? null })
      }
    }
    if (typeof child === 'object' && child !== null) entries.push(...collectTokenEntries(child, depth + 1))
  }
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
}

function dedupeOfficialApiKeyCandidates(candidates: OfficialApiKeyCandidate[]): OfficialApiKeyCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.apiKey, candidate])).values()]
}

function collectOfficialKeyMap(value: unknown, depth = 0): Map<number, string> {
  if (depth > 7 || value === null || value === undefined || typeof value !== 'object') return new Map()
  const result = new Map<number, string>()
  if (Array.isArray(value)) {
    for (const item of value) {
      for (const [id, key] of collectOfficialKeyMap(item, depth + 1)) result.set(id, key)
    }
    return result
  }
  for (const [property, child] of Object.entries(value)) {
    const id = Number(property)
    if (Number.isInteger(id) && id > 0) {
      const key = collectOfficialApiKeys(child)[0]
      if (key) result.set(id, key)
    }
    if (typeof child === 'object' && child !== null) {
      for (const [nestedId, key] of collectOfficialKeyMap(child, depth + 1)) result.set(nestedId, key)
    }
  }
  return result
}

function collectOfficialApiKeys(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return []
  if (typeof value === 'string') {
    const key = normalizeOfficialApiKey(value)
    return key ? [key] : []
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectOfficialApiKeys(item, depth + 1))
  if (typeof value !== 'object') return []

  const keys: string[] = []
  for (const [property, child] of Object.entries(value)) {
    if (/^(?:key|api_key|apiKey|key_value|keyValue|api_key_value|apiKeyValue|token|accessKey|access_key|secret|value|content|raw_key|rawKey|api_token|apiToken)$/.test(property) && typeof child === 'string') {
      const key = normalizeOfficialApiKey(child)
      if (key) keys.push(key)
    }
    if (typeof child === 'object' && child !== null) keys.push(...collectOfficialApiKeys(child, depth + 1))
  }
  return [...new Set(keys)]
}

function isOfficialApiKeyValue(value: string): boolean {
  const candidate = value.trim()
  if (candidate.length < 16 || candidate.length > 512) return false
  if (!/^[^\s\u0000-\u001f\u007f]+$/.test(candidate)) return false
  if (candidate.split('.').length === 3) return false
  if (/^(?:Bearer\s|eyJ|access[_-]?token|refresh[_-]?token|session|cookie)/i.test(candidate)) return false
  if (candidate.includes('...') || candidate.includes('…') || /\*{2,}/.test(candidate)) return false
  if (/^(?:sk-)?(?:\.\.\.|•{2,}|\*{2,})/i.test(candidate)) return false
  if (/^(?:sk-)?[A-Za-z0-9_-]{0,8}(?:\.\.\.|•{2,}|\*{2,})/i.test(candidate)) return false
  return true
}

function normalizeOfficialApiKey(value: string): string | null {
  const candidate = value.trim()
  if (!candidate || /^(?:Bearer\s|eyJ|access[_-]?token|refresh[_-]?token|session|cookie)/i.test(candidate)) return null
  return isOfficialApiKeyValue(candidate) ? candidate : null
}

async function readNewApiAccessToken(page: Page): Promise<string | null> {
  const token = await page.evaluate(() => {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ['auth_token', 'access_token', 'accesstoken', 'token']) {
        const direct = storage.getItem(key)?.trim()
        if (direct && !/^(?:null|undefined|false|0|-1|guest|anonymous|public)$/i.test(direct)) {
          return direct.replace(/^Bearer\s+/i, '')
        }
      }
      const rawUser = storage.getItem('user')
      if (!rawUser || rawUser.length > 100_000) continue
      try {
        const parsed = JSON.parse(rawUser)
        const candidates = [parsed, parsed?.user, parsed?.state?.user, parsed?.data, parsed?.data?.user]
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object') continue
          for (const field of ['token', 'access_token', 'accessToken']) {
            const value = candidate[field]
            if (typeof value === 'string' && value.trim()) return value.trim().replace(/^Bearer\s+/i, '')
          }
        }
      } catch {
        // New API stores this value as JSON. Ignore unrelated plain-text values.
      }
    }
    return null
  }).catch(() => null)
  return typeof token === 'string' && token ? token : null
}

function readSnapshotAccessToken(snapshot: BrowserAuthSnapshot): string | null {
  const storageItems = Object.values(snapshot.localStorageByHost).flatMap((values) => Object.entries(values))
  for (const [key, value] of storageItems) {
    const normalized = key.toLowerCase()
    if (['auth_token', 'access_token', 'accesstoken', 'token'].includes(normalized)) {
      const direct = value.trim()
      if (direct && !/^(?:null|undefined|false|0|-1|guest|anonymous|public)$/i.test(direct)) {
        return direct.replace(/^Bearer\s+/i, '')
      }
    }
  }
  for (const [key, value] of storageItems) {
    if (key.toLowerCase() !== 'user' || value.length > 100_000) continue
    try {
      const parsed = JSON.parse(value)
      const candidates = [parsed, parsed?.user, parsed?.state?.user, parsed?.data, parsed?.data?.user]
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue
        for (const field of ['token', 'access_token', 'accessToken']) {
          const tokenValue = candidate[field]
          if (typeof tokenValue === 'string' && tokenValue.trim()) return tokenValue.trim().replace(/^Bearer\s+/i, '')
        }
      }
    } catch {
      // Ignore unrelated user storage.
    }
  }
  return null
}

async function readNewApiLegacyUserId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const keys = ['uid', 'user_id', 'userId', 'new-api-user']
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of keys) {
        const value = storage.getItem(key)?.trim()
        if (!value || !/^\d+$/.test(value)) continue
        const id = Number(value)
        if (Number.isSafeInteger(id) && id > 0) return id
      }
      const rawUser = storage.getItem('user')
      if (!rawUser || rawUser.length > 100_000) continue
      try {
        const parsed = JSON.parse(rawUser)
        const candidates = [parsed, parsed?.user, parsed?.state?.user, parsed?.data, parsed?.data?.user]
        for (const candidate of candidates) {
          const id = Number(candidate?.id ?? candidate?.uid ?? candidate?.user_id)
          if (Number.isSafeInteger(id) && id > 0) return id
        }
      } catch {
        // Ignore unrelated or partially-written storage values.
      }
    }
    return null
  }).catch(() => null)
}

async function readSub2ApiToken(page: Page, kind: 'access' | 'refresh'): Promise<string | null> {
  return page.evaluate((tokenKind) => {
    const keys = tokenKind === 'refresh'
      ? ['refresh_token', 'refreshToken']
      : ['auth_token', 'access_token', 'accessToken', 'sub2api_token', 'token']
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of keys) {
        const value = storage.getItem(key)?.trim()
        if (value) return value.replace(/^Bearer\s+/i, '')
      }
    }
    return null
  }, kind).catch(() => null)
}

async function readYiApiAccessToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ['auth_token', 'access_token', 'accessToken']) {
        const value = storage.getItem(key)?.trim()
        if (value) return value.replace(/^Bearer\s+/i, '')
      }
    }
    return null
  }).catch(() => null)
}

function normalizeNewApiUser(value: unknown): RemoteUser | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  const nestedData = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : null
  const nestedUser = payload.user && typeof payload.user === 'object'
    ? payload.user as Record<string, unknown>
    : nestedData?.user && typeof nestedData.user === 'object'
      ? nestedData.user as Record<string, unknown>
      : null
  const source = nestedUser ?? nestedData ?? payload
  const id = numberOrNull(source.id ?? payload.id)
  const quota = numberOrNull(source.quota ?? payload.quota)
  const balance = numberOrNull(source.balance ?? payload.balance)
  const user: RemoteUser = {}
  if (id !== null) user.id = id
  if (typeof source.username === 'string') user.username = source.username
  if (typeof source.display_name === 'string') user.display_name = source.display_name
  if (quota !== null) user.quota = quota
  if (balance !== null) user.balance = balance
  return user.id !== undefined
    || user.username !== undefined
    || user.display_name !== undefined
    || user.quota !== undefined
    || user.balance !== undefined
    ? user
    : null
}

function newApiUserBalance(user: RemoteUser): number | null {
  return numberOrNull(user.quota ?? user.balance)
}

function normalizeYiApiUser(value: unknown): RemoteUser | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  const nestedData = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : null
  const nestedUser = payload.user && typeof payload.user === 'object'
    ? payload.user as Record<string, unknown>
    : nestedData?.user && typeof nestedData.user === 'object'
      ? nestedData.user as Record<string, unknown>
      : null
  const source = nestedUser ?? nestedData ?? payload
  const balance = numberOrNull(
    source.balance
    ?? source.quota
    ?? source.remaining
    ?? source.available_balance
    ?? source.wallet_balance
    ?? source.walletBalance
    ?? payload.balance
    ?? payload.quota,
  )
  const id = numberOrNull(source.id ?? payload.id)
  const user: RemoteUser = {}
  if (id !== null) user.id = id
  if (typeof source.username === 'string') user.username = source.username
  if (typeof source.display_name === 'string') user.display_name = source.display_name
  if (balance !== null) {
    user.balance = balance
    user.quota = balance
  }
  return user.id !== undefined || user.username !== undefined || user.display_name !== undefined || user.balance !== undefined
    ? user
    : null
}

function normalizeSub2ApiUser(value: unknown): Sub2ApiUser | null {
  const user = normalizeYiApiUser(value)
  if (!user) return null
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : null
  const nestedUser = payload.user && typeof payload.user === 'object'
    ? payload.user as Record<string, unknown>
    : nestedData?.user && typeof nestedData.user === 'object'
      ? nestedData.user as Record<string, unknown>
      : null
  const source = nestedUser ?? nestedData ?? payload
  const email = typeof source.email === 'string' ? source.email : undefined
  return email ? { ...user, email } : user
}

function buildAuthHeaders(auth: RemoteAuth): Record<string, string> {
  if (auth.adapter === 'new-api-modern' && auth.accessToken) return { Authorization: `Bearer ${auth.accessToken}` }
  if (auth.adapter === 'new-api-legacy' && auth.legacyUserId) return { 'New-API-User': String(auth.legacyUserId) }
  if (auth.adapter === 'local-api' && auth.sessionToken) return { 'x-user-token': auth.sessionToken }
  return {}
}

function buildCheckinHeaders(auth: RemoteAuth, nonce?: string): Record<string, string> {
  const headers = buildAuthHeaders(auth)
  if (!nonce) return headers
  const userId = Number(auth.user.id ?? auth.legacyUserId)
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('站点要求签到签名，但无法读取用户 ID')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHash('sha256').update(`${userId}:${timestamp}:${nonce}`).digest('hex')
  return {
    ...headers,
    'X-Checkin-Timestamp': timestamp,
    'X-Checkin-Signature': signature,
  }
}

function resolveServerBaseUrl(serverAddress: string | undefined, fallback: string): string {
  if (!serverAddress) return fallback
  try {
    const fallbackUrl = new URL(fallback)
    const candidate = new URL(serverAddress)
    if (!['http:', 'https:'].includes(candidate.protocol)) return fallback
    if (fallbackUrl.protocol === 'https:' && candidate.protocol !== 'https:') return fallback
    return candidate.origin
  } catch {
    return fallback
  }
}

function adapterLabel(adapter: AdapterType): string {
  if (adapter === 'new-api-modern') return '新版 New API'
  if (adapter === 'new-api-legacy') return '旧版 New API'
  if (adapter === 'local-api') return 'LocalAPI'
  if (adapter === 'sub2api') return 'Sub2API'
  if (adapter === 'fengwind-welfare') return 'Fengwind 福利站'
  if (adapter === 'hybgzs-welfare') return '黑与白福利站'
  if (adapter === 'chy-traffic') return 'CHY 流量签到'
  return '未知站点'
}

function hasExactHostname(baseUrl: string, hostname: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === hostname
  } catch {
    return false
  }
}

function getDashboardUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    // Any Router keeps the authenticated New API console under /console;
    // /dashboard is a legacy route and can leave the browser on a public shell
    // where the session-backed /api/user/self response resolves to quota 0.
    if (isAnyRouterSite(baseUrl)) {
      url.pathname = '/console'
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    }
    if (/^\/dashboard\/?$/i.test(url.pathname)) return null
    url.pathname = '/dashboard'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function isChyTrafficSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'dy.chybenzun.top')
}

function isSub2ApiSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'token.dialoguedui.com')
    || isFastAiTokenSite(baseUrl)
    || isAihubSite(baseUrl)
    || isGateAiSite(baseUrl)
}

function isFastAiTokenSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'fastaitoken.com') || hasExactHostname(baseUrl, 'www.fastaitoken.com')
}

function isGateAiSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'gateai.cc') || hasExactHostname(baseUrl, 'www.gateai.cc')
}

function moneyForSub2ApiSite(site: Site) {
  if (isFastAiTokenSite(site.baseUrl)) return fastAiTokenMoney
  if (isAihubSite(site.baseUrl)) return aihubMoney
  if (isGateAiSite(site.baseUrl)) return gateAiMoney
  return sub2ApiMoney
}

function isAihubSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'aihub.top') || hasExactHostname(baseUrl, 'www.aihub.top')
}

function isYiApiSite(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '')
    return hostname === 'yiapi.ai' || hostname === 'www.yiapi.ai'
  } catch {
    return false
  }
}

function isTrueSotaSite(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '')
    return hostname === 'true-sota.com' || hostname === 'www.true-sota.com'
  } catch {
    return false
  }
}

function isFengwindWelfareSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'api-welfalre.fengwind.com')
}

function isHybgzsWelfareSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'cdk.hybgzs.com')
}

async function readHybgzsWelfarePageState(page: Page): Promise<HybgzsWelfarePageState> {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const challengeVisible = /闪闪发光的人类请验证|完成验证后自动签到|点击验证|Powered by 欧阳淇淇/.test(bodyText)
    const signed = /今日已领工资|今日已签到|签到成功[！!]?获得|签到成功 · 奖励已到账/.test(bodyText)
    const errorMessage = bodyText.match(/(?:签到失败|验证失败|网络错误|请先登录|登录已失效)[^\n]{0,120}/)?.[0] || null
    return { signed, challengeVisible, errorMessage }
  }).catch(() => ({ signed: false, challengeVisible: false, errorMessage: null }))
}

async function clickHybgzsWelfareVerification(page: Page): Promise<boolean> {
  // The site has used both semantic checkbox controls and a text-labelled button.
  // Try the stable accessible forms first, then reach the button next to its label.
  const candidates: Array<() => Locator> = [
    () => page.getByRole('checkbox', { name: /点击验证|证明你是人类/ }),
    () => page.getByRole('button', { name: /点击验证|证明你是人类/ }),
    () => page.getByText('点击验证', { exact: true }).locator('xpath=../../button'),
    () => page.locator('[role="checkbox"]'),
    () => page.locator('input[type="checkbox"]'),
  ]

  for (const createCandidate of candidates) {
    try {
      const candidate = createCandidate()
      if (await candidate.count() === 0) continue
      await candidate.click({ timeout: 2_500 })
      return true
    } catch {
      // The CAP widget can render after its dialog shell. Continue with the next known shape.
    }
  }
  return false
}

function isAnyRouterSite(baseUrl: string): boolean {
  return hasExactHostname(baseUrl, 'anyrouter.top') || hasExactHostname(baseUrl, 'www.anyrouter.top')
}

function isTrustedAnyRouterBalance(site: Site, balanceRead: NewApiBalanceRead): boolean {
  if (balanceRead.balance !== 0) return true
  const userId = numberOrNull(balanceRead.auth.user.id)
  if (userId !== null && userId <= 0) return false
  const candidateNames = [balanceRead.auth.user.username, balanceRead.auth.user.display_name]
  if (userId === null && candidateNames.some(isAnonymousAnyRouterIdentity)) return false
  if (site.legacyUserId !== null) return userId === site.legacyUserId
  if (userId !== null && userId > 0) return true
  if (!site.username) return false
  const expected = site.username.trim().toLowerCase()
  if (isAnonymousAnyRouterIdentity(expected)) return false
  return candidateNames.some((value) => typeof value === 'string' && !isAnonymousAnyRouterIdentity(value) && value.trim().toLowerCase() === expected)
}

function isAnonymousAnyRouterIdentity(value: unknown): boolean {
  return typeof value === 'string' && /^(?:guest|anonymous|public)$/i.test(value.trim())
}

function isUnsupportedNewApiCheckinEndpoint(response: Pick<RemoteResponse, 'httpStatus' | 'contentType'>): boolean {
  return response.httpStatus === 404 && !response.contentType.toLowerCase().includes('json')
}

async function readChyTrafficPage(page: Page): Promise<ChyTrafficPageState> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
    const bodyText = document.body?.innerText || ''
    const stats = { total: null as number | null, used: null as number | null, remaining: null as number | null }
    for (const element of document.querySelectorAll('.stat')) {
      const label = (element.querySelector('.l')?.textContent || '').replace(/\s+/g, ' ').trim()
      const rawValue = (element.querySelector('.v')?.textContent || element.textContent || '').replace(/\s+/g, ' ').trim()
      const match = rawValue.match(/([\d,.]+)\s*(KB|MB|GB|TB|PB)\b/i)
      if (!match) continue
      const amount = Number(match[1]?.replaceAll(',', ''))
      if (!Number.isFinite(amount)) continue
      const unit = match[2]?.toUpperCase()
      const multiplier = unit === 'PB' ? 1024 * 1024 : unit === 'TB' ? 1024 : unit === 'MB' ? 1 / 1024 : unit === 'KB' ? 1 / (1024 * 1024) : 1
      const value = amount * multiplier
      if (/总额度/.test(label)) stats.total = value
      else if (/已使用|已用/.test(label)) stats.used = value
      else if (/剩余/.test(label)) stats.remaining = value
    }

    let claim: { href: string; text: string } | null = null
    for (const element of document.querySelectorAll('a[href], button, input[type="submit"]')) {
      const text = (element.textContent || (element instanceof HTMLInputElement ? element.value : '')).replace(/\s+/g, ' ').trim()
      if (!/领取|签到/.test(text)) continue
      const rawHref = element instanceof HTMLAnchorElement
        ? element.href
        : element instanceof HTMLButtonElement || element instanceof HTMLInputElement
          ? element.formAction
          : ''
      if (!rawHref) continue
      const target = new URL(rawHref, location.href)
      if (target.origin !== location.origin) continue
      claim = { href: `${target.pathname}${target.search}`, text }
      break
    }

    const hasLogout = [...document.querySelectorAll('a[href], button')].some((element) => {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim()
      const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : ''
      return /退出|登出|logout/i.test(`${text} ${href}`)
    })
    const loginRequired = /使用\s*Linux\.?do\s*登录|登录即可获取|请先登录/i.test(bodyText)
    const authenticated = !loginRequired && (hasLogout || stats.remaining !== null)
    const username = (document.querySelector('[data-username], .username, .user-name')?.textContent || '').replace(/\s+/g, ' ').trim() || null
    return {
      authenticated,
      title: document.title,
      username,
      stats,
      claim,
      alreadyClaimed: !claim && /今日已领取|今日已签到|明日再来|已领取/.test(bodyText),
    }
      })
    } catch (error) {
      lastError = error
      if (!isNavigationContextError(error) || attempt === 2) throw error
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('读取 CHY 页面状态失败')
}

function deriveMoneySettings(status?: RemoteStatus) {
  const quotaPerUnit = Number(status?.quota_per_unit) > 0 ? Number(status?.quota_per_unit) : 500_000
  const displayType = String(status?.quota_display_type ?? 'USD').toUpperCase()
  if (displayType === 'TOKENS') return { currencySymbol: 'T', quotaPerUnit: 1, displayScale: 1 }
  if (displayType === 'CNY') {
    return { currencySymbol: '¥', quotaPerUnit, displayScale: Number(status?.usd_exchange_rate) || 1 }
  }
  if (displayType === 'CUSTOM') {
    const customSymbol = String(status?.custom_currency_symbol ?? '').trim().toUpperCase()
    const displayScale = customSymbol && !['$', 'USD'].includes(customSymbol)
      ? Number(status?.custom_currency_exchange_rate) || 1
      : 1
    return {
      currencySymbol: status?.custom_currency_symbol || '$',
      quotaPerUnit,
      displayScale,
    }
  }
  return { currencySymbol: '$', quotaPerUnit, displayScale: 1 }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeAccessTokenExpiry(value: unknown): number | null {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw < 1_000_000_000_000 ? raw * 1000 : raw
}

function findTodayRecord(records?: CheckinStats['records']) {
  const today = localDateKey(new Date())
  return records?.find((record) => record.checkin_date && localDateKey(record.checkin_date) === today)
}

function isManualMessage(message: string): boolean {
  return /turnstile|captcha|验证|登录|unauthorized|forbidden|challenge/i.test(message)
}

// 需人工处理的原因里，只有登录/授权类才应该把站点的登录状态标记为异常。
// 验证码、人机验证这类是「登录正常但签到那一步要人工」，登录列应保持有效。
function isLoginRelatedMessage(message: string): boolean {
  return /登录|登陆|未授权|重新授权|token|session|unauthorized|forbidden/i.test(message)
}

function isDefinitiveAuthenticationResponse(response: Pick<RemoteResponse, 'httpStatus' | 'contentType' | 'message'>): boolean {
  if (response.httpStatus === 401) return true
  if (response.httpStatus !== 403) return false
  return response.contentType.toLowerCase().includes('json') && isLoginRelatedMessage(response.message ?? 'Forbidden')
}

function isBrowserVerificationResponse(response: Pick<RemoteResponse, 'httpStatus' | 'contentType' | 'message'>): boolean {
  return response.httpStatus === 403
    && !response.contentType.toLowerCase().includes('json')
    && /浏览器验证|browser verification/i.test(response.message ?? '')
}

function isDefinitiveAuthenticationFailure(response: Pick<RemoteResponse, 'httpStatus' | 'contentType' | 'message'>): boolean {
  if (isDefinitiveAuthenticationResponse(response)) return true
  return response.contentType.toLowerCase().includes('json') && isLoginRelatedMessage(response.message ?? '')
}

function isAlreadyCheckedMessage(message: string): boolean {
  return /今日已签到|already\s*(?:checked|signed)|duplicate/i.test(message)
}

async function inspectLegacyAuthResponse(
  response: Response,
  allowedOrigins: ReadonlySet<string>,
  userIds: Set<number>,
): Promise<void> {
  try {
    const url = new URL(response.url())
    if (!allowedOrigins.has(url.origin) || !url.pathname.startsWith('/api/')) return
    if (!response.headers()['content-type']?.includes('application/json')) return
    const payload = await response.json() as {
      id?: unknown
      user?: { id?: unknown }
      data?: { id?: unknown; user?: { id?: unknown } }
    }
    const candidates = [payload.id, payload.user?.id, payload.data?.id, payload.data?.user?.id]
    for (const candidate of candidates) {
      const userId = Number(candidate)
      if (Number.isInteger(userId) && userId > 0) userIds.add(userId)
    }
  } catch {
    // OAuth response inspection is opportunistic; regular storage detection remains available.
  }
}

async function detectChallenge(page: Page): Promise<string | null> {
  const result = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 1200),
  })).catch(() => ({ title: '', text: '' }))
  const content = `${result.title}\n${result.text}`
  if (/just a moment|verify you are human|checking your browser|安全验证|人机验证/i.test(content)) {
    return '站点要求浏览器验证，请打开授权窗口人工完成'
  }
  return null
}
