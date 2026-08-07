export type AdapterType = 'new-api-modern' | 'new-api-legacy' | 'local-api' | 'sub2api' | 'fengwind-welfare' | 'hybgzs-welfare' | 'chy-traffic' | 'unknown'

export type AuthStatus =
  | 'unknown'
  | 'authorizing'
  | 'valid'
  | 'expired'
  | 'manual_required'

export type CheckinStatus =
  | 'never'
  | 'running'
  | 'success'
  | 'already_checked'
  | 'failed'
  | 'manual_required'
  | 'disabled'

export type RunTrigger = 'manual' | 'scheduled' | 'retry'

export interface Site {
  id: number
  name: string
  baseUrl: string
  note: string
  faviconUrl: string | null
  faviconCustom: boolean
  adapter: AdapterType
  enabled: boolean
  authStatus: AuthStatus
  username: string | null
  legacyUserId: number | null
  currencySymbol: string
  quotaPerUnit: number
  displayScale: number
  lastBalanceRaw: number | null
  lastBalanceAmount: number | null
  lastBalanceUpdatedAt?: string | null
  lastCheckedAt: string | null
  lastStatus: CheckinStatus
  lastRewardAmount: number | null
  lastRewardAt: string | null
  lastBalanceDeltaAmount: number | null
  lastError: string | null
  authSyncedAt?: string | null
  authSyncStatus?: 'waiting' | 'claimed' | 'success' | 'failed' | 'cancelled' | null
  authSyncMessage?: string | null
  authSyncCookieCount?: number
  authSyncLocalStorageCount?: number
  createdAt: string
  updatedAt: string
}

export interface CheckinRun {
  id: number
  trigger: RunTrigger
  status: 'running' | 'completed' | 'partial' | 'failed'
  startedAt: string
  completedAt: string | null
  successCount: number
  failedCount: number
  skippedCount: number
}

export interface CheckinResult {
  id: number
  runId: number
  siteId: number
  siteName: string
  status: CheckinStatus
  rewardRaw: number | null
  rewardAmount: number | null
  balanceBeforeRaw: number | null
  balanceBeforeAmount: number | null
  balanceAfterRaw: number | null
  balanceAfterAmount: number | null
  balanceDeltaAmount: number | null
  message: string
  startedAt: string
  completedAt: string
  /**
   * 本次执行是否已确认登录仍然有效。用于区分「登录失效导致的需人工处理」和
   * 「登录正常、只是签到那一步需要人工（例如站点签到要输入验证码）」。
   * 只在写入时参与判断站点的 authStatus，不落库，从数据库读回时为 undefined。
   */
  loginVerified?: boolean
}

export interface SiteDeletionLog {
  id: number
  siteId: number
  siteName: string
  baseUrl: string
  message: string
  deletedAt: string
}

export interface AppSettings {
  scheduleEnabled: boolean
  scheduleWindowStart: string
  scheduleWindowEnd: string
  timezone: string
  retryCount: number
  retryDelayMinutes: number
  requestTimeoutSeconds: number
  browserNotifications: boolean
  telegramEnabled: boolean
  telegramBotToken: string
  telegramChatId: string
  keepBrowserOpen: boolean
  historyRetentionDays: number
}

export interface DashboardSummary {
  totalSites: number
  enabledSites: number
  successToday: number
  failedToday: number
  manualRequiredToday: number
  rewardToday: number
  rewardTodayByCurrency: Record<string, number>
  nextRunAt: string | null
  schedulerRunning: boolean
}

export interface AppState {
  sites: Site[]
  channelLinks: SiteChannelLink[]
  authSyncEvents: AuthSyncEvent[]
  summary: DashboardSummary
  recentResults: CheckinResult[]
  recentDeletions: SiteDeletionLog[]
  recentRuns: CheckinRun[]
  settings: AppSettings
}

export interface AuthSyncEvent {
  id: number
  siteId: number
  method: 'assistant'
  status: 'waiting' | 'claimed' | 'success' | 'failed' | 'cancelled'
  message: string
  cookieCount: number
  localStorageCount: number
  startedAt: string
  claimedAt: string | null
  completedAt: string | null
}

export interface SiteChannelLink {
  siteId: number
  channelId: string
  createdAt: string
}

export interface AuthAssistantPairing {
  pairId: string
  code: string
  siteId: number
  siteName: string
  domain: string
  siteUrl: string
  adapter: AdapterType
  expiresAt: string
  uploadPath: '/auth-assistant/upload'
  claimPath: '/auth-assistant/claim'
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

export interface ChannelImportPreview {
  candidateId: string
  siteName: string
  keyName: string
  baseUrl: string
  protocol: string
  models: string[]
  keyLast4: string
  validation: {
    status: 'not_probed'
    ok: boolean
    chatOk: boolean
    streamOk: boolean
    latencyMs: number
    balance: number | null
    balanceCurrency: string | null
    balanceStatus: 'ok' | 'low' | 'exhausted' | 'unknown' | 'error'
  }
  matchedChannel: {
    id: string
    name: string
    baseUrl: string
    keyName: string
    keyLast4: string
    models: string[]
  } | null
  expiresAt: string
}

export interface ChannelImportPrepareResult {
  candidates: ChannelImportPreview[]
}

export interface ChannelImportModelResult {
  protocol: string
  models: string[]
  error: string | null
}

export interface ChannelImportResult {
  action: 'created' | 'updated'
  channel: {
    id: string
    name: string
    providerName: string
    baseUrl: string
    protocol: string
    keyLast4: string
    models: string[]
    status: string
  }
  probe: null | {
    ok: boolean
    latencyMs: number
    balance: number | null
    balanceCurrency: string | null
    balanceStatus: string
    error: string | null
  }
}

export interface ChannelBalanceLinkResult {
  link: SiteChannelLink | null
  channel: ChannelImportResult['channel']
  synced: boolean
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  message?: string
}
