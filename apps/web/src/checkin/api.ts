import type {
  ApiResponse,
  AppSettings,
  AppState,
  AuthAssistantPairing,
  AuthAssistantPairingStatus,
  ChannelImportPreview,
  ChannelImportPrepareResult,
  ChannelImportModelResult,
  ChannelImportResult,
  CheckinMode,
  CheckinRun,
  LocalExecutionInfo,
  LocalExecutionOperation,
  LocalExecutionStatus,
  RunProgressEntry,
  Site,
} from './shared/types'

const tokenKey = 'autoapi-admin-session'

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${localStorage.getItem(tokenKey) ?? ''}`,
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(authHeaders())
  if (options?.headers) {
    new Headers(options.headers).forEach((value, key) => headers.set(key, value))
  }
  if (options?.body !== undefined && !headers.has('content-type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
  })
  const raw = await response.text()
  let payload: (ApiResponse<T> & { error?: { message?: string; requestId?: string }; message?: string }) | null = null
  try {
    payload = raw ? JSON.parse(raw) as ApiResponse<T> & { error?: { message?: string; requestId?: string }; message?: string } : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || raw.trim() || `请求失败（HTTP ${response.status}）`
    const requestId = payload?.error?.requestId
    throw new Error(requestId ? `${message}（请求 ID：${requestId}）` : message)
  }
  if (!payload) throw new Error(`服务返回了空响应（HTTP ${response.status}）`)
  return ('data' in payload && payload.success === true ? payload.data : payload) as T
}

export const api = {
  getState: () => request<AppState>('/admin/checkin/state'),
  addSite: (input: { name?: string; baseUrl: string; note?: string; faviconUrl?: string | null; checkinMode?: CheckinMode }) => request<Site>('/admin/checkin/sites', { method: 'POST', body: JSON.stringify(input) }),
  addSitesBulk: (urls: string[], checkinMode: CheckinMode = 'checkin') => request<{ created: Site[]; skipped: Array<{ input: string; reason: string }> }>('/admin/checkin/sites/bulk', { method: 'POST', body: JSON.stringify({ urls, checkinMode }) }),
  updateSite: (id: number, input: Partial<Pick<Site, 'name' | 'baseUrl' | 'note' | 'faviconUrl' | 'enabled' | 'checkinMode'>>) => request<Site>(`/admin/checkin/sites/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  refreshSiteFavicon: (id: number) => request<Site>(`/admin/checkin/sites/${id}/favicon/refresh`, { method: 'POST', body: '{}' }),
  deleteSite: (id: number) => request<{ ok: true; warnings?: string[] }>(`/admin/checkin/sites/${id}`, { method: 'DELETE' }),
  createAuthAssistantPair: (id: number) => request<AuthAssistantPairing>(`/admin/checkin/sites/${id}/auth-assistant/pair`, { method: 'POST', body: '{}' }),
  getAuthAssistantPair: (siteId: number, pairId: string) => request<AuthAssistantPairingStatus>(`/admin/checkin/sites/${siteId}/auth-assistant/pair/${pairId}`),
  cancelAuthAssistantPair: (siteId: number, pairId: string) => request<AuthAssistantPairingStatus>(`/admin/checkin/sites/${siteId}/auth-assistant/pair/${pairId}`, { method: 'DELETE' }),
  createLocalExecution: (siteId: number, operation: LocalExecutionOperation) => request<LocalExecutionInfo>(`/admin/checkin/sites/${siteId}/auth-assistant/local-execution`, { method: 'POST', body: JSON.stringify({ operation }) }),
  getLocalExecution: (siteId: number, executionId: string) => request<LocalExecutionStatus>(`/admin/checkin/sites/${siteId}/auth-assistant/local-execution/${executionId}`),
  cancelLocalExecution: (siteId: number, executionId: string) => request<LocalExecutionStatus>(`/admin/checkin/sites/${siteId}/auth-assistant/local-execution/${executionId}`, { method: 'DELETE' }),
  prepareChannelImport: (id: number) => request<ChannelImportPrepareResult>(`/admin/checkin/sites/${id}/channel-import/prepare`, { method: 'POST', body: '{}' }),
  discoverChannelImportModels: (id: number, candidateId: string) => request<ChannelImportModelResult>(`/admin/checkin/sites/${id}/channel-import/models`, { method: 'POST', body: JSON.stringify({ candidateId }) }),
  confirmChannelImport: (id: number, input: { candidateId: string; name: string; models: string[]; priority: number; weight: number; tags: string[] }) => request<ChannelImportResult>(`/admin/checkin/sites/${id}/channel-import/confirm`, { method: 'POST', body: JSON.stringify(input) }),
  linkChannelBalance: (id: number, channelId: string) => request<import('./shared/types').ChannelBalanceLinkResult>(`/admin/checkin/sites/${id}/channel-link`, { method: 'POST', body: JSON.stringify({ channelId }) }),
  syncChannelBalance: (id: number) => request<{ updatedChannelIds: string[]; skippedBecauseBalanceIsUnknown: boolean; refreshed: boolean; result: { status: string; message: string; balance: number | null; currency: string | null } | null }>(`/admin/checkin/sites/${id}/channel-balance/sync`, { method: 'POST', body: '{}' }),
  runCheckin: (siteIds?: number[]) => request<CheckinRun>('/admin/checkin/checkin/run', { method: 'POST', body: JSON.stringify(siteIds ? { siteIds } : {}) }),
  getRunProgress: (runId: number) => request<{ runId: number; entries: RunProgressEntry[] }>(`/admin/checkin/progress/${runId}`),
  saveSettings: (settings: AppSettings) => request<AppSettings>('/admin/checkin/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  testTelegram: (input: { botToken: string; chatId: string }) => request<{ sent: boolean }>('/admin/checkin/settings/telegram/test', { method: 'POST', body: JSON.stringify(input) }),
}
