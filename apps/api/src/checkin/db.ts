import { DatabaseSync } from 'node:sqlite'
import type {
  AdapterType,
  AppSettings,
  AuthStatus,
  CheckinResult,
  CheckinRun,
  CheckinStatus,
  DashboardSummary,
  RunTrigger,
  Site,
} from './types.js'
import { databasePath, ensureDataDirectories } from './config.js'
import { localDateKey, nowIso } from './utils.js'

type Row = Record<string, unknown>

export interface StoredSiteIconAsset {
  url: string
  body: Uint8Array
  contentType: string
}

export interface StoredIconAsset {
  url: string
  body: Uint8Array
  contentType: string
  updatedAt: string
}

export interface SiteChannelLink {
  siteId: number
  channelId: string
  createdAt: string
}

export const defaultSettings: AppSettings = {
  scheduleEnabled: true,
  scheduleWindowStart: '08:00',
  scheduleWindowEnd: '10:00',
  timezone: 'Asia/Shanghai',
  retryCount: 2,
  retryDelayMinutes: 5,
  requestTimeoutSeconds: 30,
  browserNotifications: true,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  keepBrowserOpen: false,
  historyRetentionDays: 365,
}

function bool(value: unknown): boolean {
  return Number(value) === 1
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function mapSite(row: Row): Site {
  return {
    id: Number(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    note: String(row.note ?? ''),
    faviconUrl: row.favicon_url === null || row.favicon_url === undefined ? null : String(row.favicon_url),
    faviconCustom: bool(row.favicon_custom),
    adapter: String(row.adapter) as AdapterType,
    enabled: bool(row.enabled),
    authStatus: String(row.auth_status) as AuthStatus,
    username: row.username === null ? null : String(row.username),
    legacyUserId: nullableNumber(row.legacy_user_id),
    currencySymbol: String(row.currency_symbol),
    quotaPerUnit: Number(row.quota_per_unit),
    displayScale: Number(row.display_scale),
    lastBalanceRaw: nullableNumber(row.last_balance_raw),
    lastBalanceAmount: nullableNumber(row.last_balance_amount),
    lastCheckedAt: row.last_checked_at === null ? null : String(row.last_checked_at),
    lastStatus: String(row.last_status) as CheckinStatus,
    lastRewardAmount: nullableNumber(row.last_reward_amount),
    lastRewardAt: row.last_reward_at === null || row.last_reward_at === undefined ? null : String(row.last_reward_at),
    lastBalanceDeltaAmount: nullableNumber(row.last_balance_delta_amount),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapRun(row: Row): CheckinRun {
  return {
    id: Number(row.id),
    trigger: String(row.trigger) as RunTrigger,
    status: String(row.status) as CheckinRun['status'],
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    successCount: Number(row.success_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count),
  }
}

function mapResult(row: Row): CheckinResult {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    siteId: Number(row.site_id),
    siteName: String(row.site_name),
    status: String(row.status) as CheckinStatus,
    rewardRaw: nullableNumber(row.reward_raw),
    rewardAmount: nullableNumber(row.reward_amount),
    balanceBeforeRaw: nullableNumber(row.balance_before_raw),
    balanceBeforeAmount: nullableNumber(row.balance_before_amount),
    balanceAfterRaw: nullableNumber(row.balance_after_raw),
    balanceAfterAmount: nullableNumber(row.balance_after_amount),
    balanceDeltaAmount: nullableNumber(row.balance_delta_amount),
    message: String(row.message),
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
  }
}

export class AppDatabase {
  private readonly db: DatabaseSync

  constructor(filename = databasePath) {
    ensureDataDirectories()
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        favicon_url TEXT,
        favicon_custom INTEGER NOT NULL DEFAULT 0 CHECK (favicon_custom IN (0, 1)),
        adapter TEXT NOT NULL DEFAULT 'unknown',
        enabled INTEGER NOT NULL DEFAULT 1,
        auth_status TEXT NOT NULL DEFAULT 'unknown',
        username TEXT,
        legacy_user_id INTEGER,
        currency_symbol TEXT NOT NULL DEFAULT '$',
        quota_per_unit REAL NOT NULL DEFAULT 500000,
        display_scale REAL NOT NULL DEFAULT 1,
        last_balance_raw REAL,
        last_balance_amount REAL,
        last_checked_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_reward_amount REAL,
        last_reward_at TEXT,
        last_balance_delta_amount REAL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkin_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS checkin_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES checkin_runs(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        site_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reward_raw REAL,
        reward_amount REAL,
        balance_before_raw REAL,
        balance_before_amount REAL,
        balance_after_raw REAL,
        balance_after_amount REAL,
        balance_delta_amount REAL,
        message TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_results_site_completed ON checkin_results(site_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_results_run ON checkin_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON checkin_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_icon_assets (
        site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS icon_asset_cache (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_catalog_snapshots (
        site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        source TEXT,
        supports_health INTEGER NOT NULL DEFAULT 0 CHECK (supports_health IN (0, 1)),
        message TEXT,
        refreshed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_models (
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        owned_by TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        health_status TEXT NOT NULL DEFAULT 'unknown',
        available_channels INTEGER,
        total_channels INTEGER,
        health_message TEXT,
        last_probe_status TEXT NOT NULL DEFAULT 'never',
        last_probe_latency_ms INTEGER,
        last_probe_at TEXT,
        last_probe_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (site_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_site_models_model ON site_models(model_id, site_id);

      CREATE TABLE IF NOT EXISTS site_channel_links (
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (site_id, channel_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_site_channel_links_channel ON site_channel_links(channel_id);

      UPDATE sites
      SET auth_status = 'expired', last_error = '上次授权流程已中断，请重新授权', updated_at = datetime('now')
      WHERE auth_status = 'authorizing';
    `)
    this.addColumnIfMissing('sites', 'note', "TEXT NOT NULL DEFAULT ''")
    this.addColumnIfMissing('sites', 'favicon_url', 'TEXT')
    const faviconCustomAdded = this.addColumnIfMissing(
      'sites',
      'favicon_custom',
      'INTEGER NOT NULL DEFAULT 0 CHECK (favicon_custom IN (0, 1))',
    )
    if (faviconCustomAdded) {
      this.db.exec('UPDATE sites SET favicon_custom = 1 WHERE favicon_url IS NOT NULL')
    }
    this.addColumnIfMissing('sites', 'last_reward_at', 'TEXT')
    this.addColumnIfMissing('site_models', 'enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))')
    this.db.exec(`
      UPDATE sites
      SET last_reward_at = last_checked_at
      WHERE last_reward_at IS NULL AND last_reward_amount IS NOT NULL
    `)
  }

  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    if (columns.some((item) => String(item.name) === column)) return false
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    return true
  }

  close() {
    this.db.close()
  }

  listSites(): Site[] {
    return (this.db.prepare('SELECT * FROM sites ORDER BY enabled DESC, id ASC').all() as Row[]).map(mapSite)
  }

  getSite(id: number): Site | null {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Row | undefined
    return row ? mapSite(row) : null
  }

  listChannelLinks(siteId?: number): SiteChannelLink[] {
    const rows = (siteId === undefined
      ? this.db.prepare('SELECT site_id, channel_id, created_at FROM site_channel_links ORDER BY created_at ASC').all()
      : this.db.prepare('SELECT site_id, channel_id, created_at FROM site_channel_links WHERE site_id = ? ORDER BY created_at ASC').all(siteId)) as Row[]
    return rows.map((row) => ({
      siteId: Number(row.site_id),
      channelId: String(row.channel_id),
      createdAt: String(row.created_at),
    }))
  }

  linkChannel(siteId: number, channelId: string): SiteChannelLink {
    if (!this.getSite(siteId)) throw new Error('站点不存在')
    const createdAt = nowIso()
    this.db.prepare(`
      INSERT INTO site_channel_links (site_id, channel_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET site_id = excluded.site_id, created_at = excluded.created_at
    `).run(siteId, channelId, createdAt)
    return { siteId, channelId, createdAt }
  }

  unlinkChannel(siteId: number, channelId: string): boolean {
    return Number(this.db.prepare('DELETE FROM site_channel_links WHERE site_id = ? AND channel_id = ?').run(siteId, channelId).changes) > 0
  }

  createSite(name: string, baseUrl: string, note = '', faviconUrl: string | null = null): Site {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      INSERT INTO sites (name, base_url, note, favicon_url, favicon_custom, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, baseUrl, note, faviconUrl, Number(Boolean(faviconUrl)), timestamp, timestamp)
    return this.getSite(Number(result.lastInsertRowid))!
  }

  updateSite(id: number, input: { name?: string; baseUrl?: string; note?: string; faviconUrl?: string | null; enabled?: boolean }): Site | null {
    const site = this.getSite(id)
    if (!site) return null
    const baseUrl = input.baseUrl ?? site.baseUrl
    const faviconUrl = input.faviconUrl !== undefined
      ? input.faviconUrl
      : baseUrl === site.baseUrl
        ? site.faviconUrl
        : null
    const faviconCustom = input.faviconUrl !== undefined
      ? Boolean(input.faviconUrl)
      : baseUrl === site.baseUrl
        ? site.faviconCustom
        : false
    this.db.prepare(`
      UPDATE sites
      SET name = ?, base_url = ?, note = ?, favicon_url = ?, favicon_custom = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? site.name,
      baseUrl,
      input.note ?? site.note,
      faviconUrl,
      Number(faviconCustom),
      input.enabled === undefined ? Number(site.enabled) : Number(input.enabled),
      nowIso(),
      id,
    )
    if (faviconUrl !== site.faviconUrl) this.clearSiteIconAsset(id)
    return this.getSite(id)
  }

  updateSiteFavicon(id: number, faviconUrl: string | null, expectedBaseUrl?: string): Site | null {
    const site = this.getSite(id)
    if (!site) return null
    if (expectedBaseUrl === undefined) {
      this.db.prepare(`
        UPDATE sites SET favicon_url = ?, updated_at = ?
        WHERE id = ? AND favicon_custom = 0
      `).run(faviconUrl, nowIso(), id)
    } else {
      this.db.prepare(`
        UPDATE sites SET favicon_url = ?, updated_at = ?
        WHERE id = ? AND favicon_custom = 0 AND base_url = ?
      `).run(faviconUrl, nowIso(), id, expectedBaseUrl)
    }
    const updated = this.getSite(id)
    if (updated?.faviconUrl !== site.faviconUrl) this.clearSiteIconAsset(id)
    return updated
  }

  getSiteIconAsset(siteId: number, url: string): StoredSiteIconAsset | null {
    const row = this.db.prepare(`
      SELECT url, content_type, body FROM site_icon_assets
      WHERE site_id = ? AND url = ?
    `).get(siteId, url) as Row | undefined
    if (!row || !(row.body instanceof Uint8Array)) return null
    return {
      url: String(row.url),
      contentType: String(row.content_type),
      body: new Uint8Array(row.body),
    }
  }

  saveSiteIconAsset(siteId: number, asset: StoredSiteIconAsset): void {
    this.db.prepare(`
      INSERT INTO site_icon_assets (site_id, url, content_type, body, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_id) DO UPDATE SET
        url = excluded.url,
        content_type = excluded.content_type,
        body = excluded.body,
        updated_at = excluded.updated_at
    `).run(siteId, asset.url, asset.contentType, asset.body, nowIso())
  }

  clearSiteIconAsset(siteId: number): void {
    this.db.prepare('DELETE FROM site_icon_assets WHERE site_id = ?').run(siteId)
  }

  getIconAssetCache(cacheKey: string): StoredIconAsset | null {
    const row = this.db.prepare(`
      SELECT cache_key, url, content_type, body, updated_at FROM icon_asset_cache
      WHERE cache_key = ?
    `).get(cacheKey) as Row | undefined
    if (!row || !(row.body instanceof Uint8Array)) return null
    return {
      url: String(row.url),
      contentType: String(row.content_type),
      body: new Uint8Array(row.body),
      updatedAt: String(row.updated_at),
    }
  }

  saveIconAssetCache(cacheKey: string, asset: StoredSiteIconAsset): void {
    this.db.prepare(`
      INSERT INTO icon_asset_cache (cache_key, url, content_type, body, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        url = excluded.url,
        content_type = excluded.content_type,
        body = excluded.body,
        updated_at = excluded.updated_at
    `).run(cacheKey, asset.url, asset.contentType, asset.body, nowIso())
  }

  clearIconAssetCache(cacheKey: string): void {
    this.db.prepare('DELETE FROM icon_asset_cache WHERE cache_key = ?').run(cacheKey)
  }

  touchSite(id: number): Site | null {
    if (!this.getSite(id)) return null
    this.db.prepare('UPDATE sites SET updated_at = ? WHERE id = ?').run(nowIso(), id)
    return this.getSite(id)
  }

  deleteSite(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes) > 0
  }

  updateSiteAuth(id: number, input: {
    adapter: AdapterType
    authStatus: AuthStatus
    baseUrl?: string
    username?: string | null
    legacyUserId?: number | null
    name?: string
    currencySymbol?: string
    quotaPerUnit?: number
    displayScale?: number
    lastBalanceRaw?: number | null
    lastBalanceAmount?: number | null
    lastError?: string | null
  }): Site | null {
    const site = this.getSite(id)
    if (!site) return null
    const baseUrl = input.baseUrl ?? site.baseUrl
    const faviconUrl = baseUrl === site.baseUrl ? site.faviconUrl : null
    const faviconCustom = baseUrl === site.baseUrl ? site.faviconCustom : false
    this.db.prepare(`
      UPDATE sites SET
        adapter = ?, auth_status = ?, base_url = ?, username = ?, legacy_user_id = ?, name = ?,
        currency_symbol = ?, quota_per_unit = ?, display_scale = ?, favicon_url = ?, favicon_custom = ?,
        last_balance_raw = ?, last_balance_amount = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.adapter,
      input.authStatus,
      baseUrl,
      input.username ?? site.username,
      input.legacyUserId ?? site.legacyUserId,
      input.name ?? site.name,
      input.currencySymbol ?? site.currencySymbol,
      input.quotaPerUnit ?? site.quotaPerUnit,
      input.displayScale ?? site.displayScale,
      faviconUrl,
      Number(faviconCustom),
      input.lastBalanceRaw ?? site.lastBalanceRaw,
      input.lastBalanceAmount ?? site.lastBalanceAmount,
      input.lastError ?? null,
      nowIso(),
      id,
    )
    if (faviconUrl !== site.faviconUrl) this.clearSiteIconAsset(id)
    return this.getSite(id)
  }

  markSiteRunning(id: number) {
    this.db.prepare(`UPDATE sites SET last_status = 'running', last_error = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id)
  }

  applyResult(siteId: number, result: Omit<CheckinResult, 'id' | 'siteName'>) {
    const site = this.getSite(siteId)
    if (!site) throw new Error('站点不存在')
    this.db.prepare(`
      INSERT INTO checkin_results (
        run_id, site_id, site_name, status, reward_raw, reward_amount,
        balance_before_raw, balance_before_amount, balance_after_raw, balance_after_amount,
        balance_delta_amount, message, started_at, completed_at
      ) SELECT ?, id, name, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sites WHERE id = ?
    `).run(
      result.runId,
      result.status,
      result.rewardRaw,
      result.rewardAmount,
      result.balanceBeforeRaw,
      result.balanceBeforeAmount,
      result.balanceAfterRaw,
      result.balanceAfterAmount,
      result.balanceDeltaAmount,
      result.message,
      result.startedAt,
      result.completedAt,
      siteId,
    )
    this.db.prepare(`
      UPDATE sites SET
        last_balance_raw = COALESCE(?, last_balance_raw),
        last_balance_amount = COALESCE(?, last_balance_amount),
        last_checked_at = ?, last_status = ?,
        last_reward_amount = COALESCE(?, last_reward_amount),
        last_reward_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_reward_at END,
        last_balance_delta_amount = COALESCE(?, last_balance_delta_amount),
        last_error = ?, auth_status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.balanceAfterRaw,
      result.balanceAfterAmount,
      result.completedAt,
      result.status,
      result.rewardAmount,
      result.rewardAmount,
      result.completedAt,
      result.balanceDeltaAmount,
      ['failed', 'manual_required'].includes(result.status) ? result.message : null,
      // 登录状态与签到状态分开判断：签到需人工（如站点签到要求验证码）时，只要本次
      // 已确认登录仍然有效（loginVerified），登录列就保持“登录有效”，不跟着变成“需人工处理”。
      result.status === 'manual_required'
        ? (result.loginVerified ? 'valid' : 'manual_required')
        : ['success', 'already_checked'].includes(result.status)
          ? 'valid'
          : result.loginVerified
            ? 'valid'
            : site.authStatus,
      nowIso(),
      siteId,
    )
  }

  startRun(trigger: RunTrigger): CheckinRun {
    const result = this.db.prepare('INSERT INTO checkin_runs (trigger, started_at) VALUES (?, ?)').run(trigger, nowIso())
    return this.getRun(Number(result.lastInsertRowid))!
  }

  getRun(id: number): CheckinRun | null {
    const row = this.db.prepare('SELECT * FROM checkin_runs WHERE id = ?').get(id) as Row | undefined
    return row ? mapRun(row) : null
  }

  completeRun(id: number, counts: { success: number; failed: number; skipped: number }): CheckinRun | null {
    const status: CheckinRun['status'] = counts.failed === 0 ? 'completed' : counts.success > 0 ? 'partial' : 'failed'
    this.db.prepare(`
      UPDATE checkin_runs SET status = ?, completed_at = ?, success_count = ?, failed_count = ?, skipped_count = ? WHERE id = ?
    `).run(status, nowIso(), counts.success, counts.failed, counts.skipped, id)
    return this.getRun(id)
  }

  getLastRunStartedAt(trigger: RunTrigger): string | null {
    const row = this.db
      .prepare('SELECT started_at FROM checkin_runs WHERE trigger = ? ORDER BY started_at DESC LIMIT 1')
      .get(trigger) as Row | undefined
    return row ? String(row.started_at) : null
  }

  listRecentRuns(limit = 20): CheckinRun[] {
    return (this.db.prepare('SELECT * FROM checkin_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map(mapRun)
  }

  listResults(input: { limit?: number; siteId?: number; runId?: number } = {}): CheckinResult[] {
    const limit = Math.min(1000, Math.max(1, input.limit ?? 100))
    if (input.siteId) {
      return (this.db.prepare('SELECT * FROM checkin_results WHERE site_id = ? ORDER BY completed_at DESC LIMIT ?').all(input.siteId, limit) as Row[]).map(mapResult)
    }
    if (input.runId) {
      return (this.db.prepare('SELECT * FROM checkin_results WHERE run_id = ? ORDER BY id ASC LIMIT ?').all(input.runId, limit) as Row[]).map(mapResult)
    }
    return (this.db.prepare('SELECT * FROM checkin_results ORDER BY completed_at DESC LIMIT ?').all(limit) as Row[]).map(mapResult)
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[]
    const values = Object.fromEntries(rows.map((row) => [String(row.key), JSON.parse(String(row.value))]))
    return {
      scheduleEnabled: typeof values.scheduleEnabled === 'boolean' ? values.scheduleEnabled : defaultSettings.scheduleEnabled,
      scheduleWindowStart: typeof values.scheduleWindowStart === 'string' ? values.scheduleWindowStart : defaultSettings.scheduleWindowStart,
      scheduleWindowEnd: typeof values.scheduleWindowEnd === 'string' ? values.scheduleWindowEnd : defaultSettings.scheduleWindowEnd,
      timezone: typeof values.timezone === 'string' ? values.timezone : defaultSettings.timezone,
      retryCount: typeof values.retryCount === 'number' ? values.retryCount : defaultSettings.retryCount,
      retryDelayMinutes: typeof values.retryDelayMinutes === 'number' ? values.retryDelayMinutes : defaultSettings.retryDelayMinutes,
      requestTimeoutSeconds: typeof values.requestTimeoutSeconds === 'number' ? values.requestTimeoutSeconds : defaultSettings.requestTimeoutSeconds,
      browserNotifications: typeof values.browserNotifications === 'boolean' ? values.browserNotifications : defaultSettings.browserNotifications,
      telegramEnabled: typeof values.telegramEnabled === 'boolean' ? values.telegramEnabled : defaultSettings.telegramEnabled,
      telegramBotToken: typeof values.telegramBotToken === 'string' ? values.telegramBotToken : defaultSettings.telegramBotToken,
      telegramChatId: typeof values.telegramChatId === 'string' ? values.telegramChatId : defaultSettings.telegramChatId,
      keepBrowserOpen: typeof values.keepBrowserOpen === 'boolean' ? values.keepBrowserOpen : defaultSettings.keepBrowserOpen,
      historyRetentionDays: typeof values.historyRetentionDays === 'number' ? values.historyRetentionDays : defaultSettings.historyRetentionDays,
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    const statement = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    for (const [key, value] of Object.entries(settings)) statement.run(key, JSON.stringify(value))
    return this.getSettings()
  }

  cleanupHistory(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM checkin_runs WHERE started_at < ?').run(cutoff)
  }

  getDashboardSummary(nextRunAt: string | null, schedulerRunning: boolean): DashboardSummary {
    const settings = this.getSettings()
    const sites = this.listSites()
    const today = localDateKey(new Date(), settings.timezone)
    const latestToday = new Map<number, CheckinResult>()
    for (const result of this.listResults({ limit: 1000 })) {
      if (localDateKey(result.completedAt, settings.timezone) !== today) continue
      if (!latestToday.has(result.siteId)) latestToday.set(result.siteId, result)
    }
    const results = [...latestToday.values()]
    const siteById = new Map(sites.map((site) => [site.id, site]))
    const rewardTodayByCurrency: Record<string, number> = {}
    for (const result of results) {
      if (result.rewardAmount === null) continue
      const symbol = siteById.get(result.siteId)?.currencySymbol ?? '$'
      rewardTodayByCurrency[symbol] = (rewardTodayByCurrency[symbol] ?? 0) + result.rewardAmount
    }
    return {
      totalSites: sites.length,
      enabledSites: sites.filter((site) => site.enabled).length,
      successToday: results.filter((result) => ['success', 'already_checked'].includes(result.status)).length,
      failedToday: results.filter((result) => result.status === 'failed').length,
      manualRequiredToday: results.filter((result) => result.status === 'manual_required').length,
      rewardToday: results.reduce((sum, result) => sum + (result.rewardAmount ?? 0), 0),
      rewardTodayByCurrency,
      nextRunAt,
      schedulerRunning,
    }
  }
}
