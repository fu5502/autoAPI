import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  Activity,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Menu,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import type {
  AppEvent,
} from './local-types'
import type { AppSettings, AppState, AuthAssistantPairing, AuthAssistantPairingStatus, ChannelImportPreview, ChannelImportResult, CheckinResult, Site, SiteDeletionLog } from './shared/types'
import { api } from './api'
import { api as gatewayApi } from '../api'
import type { Channel } from '../types'
import {
  authLabel,
  checkinLabel,
  formatAmount,
  formatBalance,
  formatBalanceTotalItems,
  formatDate,
  formatDateTime,
  formatRewardTotalItems,
  rewardTimingLabel,
  rewardTimingTone,
  statusTone,
} from './format'
import './checkin.css'

export type CheckinView = 'dashboard' | 'history' | 'settings'
type Toast = { id: number; title: string; message: string; tone: 'default' | 'success' | 'danger' | 'warning' }
type AuthorizationFlow = 'standalone' | 'channel-import'
type AssistantLaunchPhase = 'starting' | 'opened' | 'checking' | 'waiting-login' | 'synced' | 'unavailable' | 'failed'
type ChannelImportStatus = {
  site: Site
  phase: 'preparing' | 'confirming' | 'success' | 'error'
  operation: 'authorize' | 'prepare' | 'confirm' | 'link' | 'create'
  authorizationFlow?: AuthorizationFlow
  message?: string
  channel?: ChannelImportResult['channel']
  channelAction?: ChannelImportResult['action']
}

const navItems: Array<{ id: CheckinView; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '今日概览', icon: LayoutDashboard },
  { id: 'history', label: '签到记录', icon: ListChecks },
  { id: 'settings', label: '设置', icon: Settings },
]

function supportsAutomaticChannelImport(site: Site) {
  return !['local-api', 'fengwind-welfare', 'hybgzs-welfare', 'chy-traffic'].includes(site.adapter)
}

function channelMatchesSite(channelBaseUrl: string, siteBaseUrl: string) {
  try {
    const channel = new URL(channelBaseUrl)
    const site = new URL(siteBaseUrl)
    if (channel.origin !== site.origin) return false
    const normalizePath = (value: string) => `/${value.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '') || '/'
    const channelPath = normalizePath(channel.pathname).toLowerCase()
    const sitePath = normalizePath(site.pathname).toLowerCase()
    if (channelPath === sitePath) return true
    const prefix = sitePath === '/' ? '' : sitePath
    return channelPath === `${prefix}/v1` || channelPath.startsWith(`${prefix}/v1/`) || channelPath === `${prefix}/v1beta` || channelPath.startsWith(`${prefix}/v1beta/`)
  } catch {
    return false
  }
}

function formatChannelProtocol(protocol: string) {
  return ({
    auto: '自动识别',
    openai: 'OpenAI 兼容',
    claude: 'Claude 兼容',
    gemini: 'Gemini 兼容',
    'new-api': 'New API',
    sub2api: 'Sub2API',
  } as Record<string, string>)[protocol] ?? protocol
}

function isAssistantLaunchPhase(value: unknown): value is AssistantLaunchPhase {
  return ['starting', 'opened', 'checking', 'waiting-login', 'synced', 'unavailable', 'failed'].includes(String(value))
}

export function CheckinTabs({ view, onChange, className = '' }: { view: CheckinView; onChange: (view: CheckinView) => void; className?: string }) {
  return <nav className={`checkin-tabs ${className}`.trim()} aria-label="签到模块导航">
    {navItems.map((item) => {
      const Icon = item.icon
      return <button key={item.id} className={`checkin-tab ${view === item.id ? 'active' : ''}`} onClick={() => onChange(item.id)}><Icon size={15} /><span>{item.label}</span></button>
    })}
  </nav>
}

export default function CheckinModule({ view = 'dashboard' }: { view?: CheckinView }) {
  const [state, setState] = useState<AppState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [authAssistantPair, setAuthAssistantPair] = useState<{ site: Site; pairing: AuthAssistantPairing } | null>(null)
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [channelImport, setChannelImport] = useState<{ site: Site; candidates: ChannelImportPreview[] } | null>(null)
  const [channelImportStatus, setChannelImportStatus] = useState<ChannelImportStatus | null>(null)
  const [pendingChannelImportSite, setPendingChannelImportSite] = useState<Site | null>(null)
  const [channelBalanceLink, setChannelBalanceLink] = useState<{ site: Site; channels: Channel[]; reason: string } | null>(null)
  const [gatewayChannels, setGatewayChannels] = useState<Channel[]>([])
  const [importedSiteIds, setImportedSiteIds] = useState<number[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const browserNotifications = useRef(false)

  const notify = useCallback((title: string, message: string, tone: Toast['tone'] = 'default') => {
    const id = Date.now() + Math.random()
    setToasts((items) => [...items.slice(-3), { id, title, message, tone }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500)
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const nextState = await api.getState()
      setState(nextState)
      void gatewayApi.channels().then((channels) => {
        setGatewayChannels(channels)
        const linkedChannelIds = new Set((nextState.channelLinks ?? []).map((link) => link.channelId))
        setImportedSiteIds(nextState.sites
          .filter((site) => channels.some((channel) => linkedChannelIds.has(channel.id) && (nextState.channelLinks ?? []).some((link) => link.channelId === channel.id && link.siteId === site.id))
            || channels.some((channel) => channelMatchesSite(channel.baseUrl, site.baseUrl)))
          .map((site) => site.id))
      }).catch(() => undefined)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法连接本地服务')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    browserNotifications.current = Boolean(state?.settings.browserNotifications)
  }, [state?.settings.browserNotifications])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [view])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    const token = localStorage.getItem('autoapi-admin-session') ?? ''
    void (async () => {
      try {
        const response = await fetch('/admin/checkin/events', {
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const frames = buffer.split(/\r?\n\r?\n/)
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const eventName = frame.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim()
            if (eventName !== 'app_event') continue
            const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim()
            if (!data) continue
            let payload: AppEvent
            try {
              payload = JSON.parse(data) as AppEvent
            } catch {
              continue
            }
            if (!payload || typeof payload !== 'object') continue
            const title = typeof payload.title === 'string' && payload.title.trim()
              ? payload.title.trim()
              : '签到状态更新'
            const message = typeof payload.message === 'string' && payload.message.trim()
              ? payload.message.trim()
              : '签到页面状态已刷新'
            void refresh(true)
            const tone = payload.type === 'site_result' && /失败/.test(title)
              ? 'danger'
              : payload.type === 'site_result' && /人工/.test(title)
                ? 'warning'
                : payload.type === 'run_completed' || /成功|完成|已签到/.test(title)
                  ? 'success'
                  : 'default'
            notify(title, message, tone)
            if (browserNotifications.current && Notification.permission === 'granted') {
              new Notification(title, { body: message, tag: payload.type })
            }
          }
        }
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) return
      }
    })()
    return () => controller.abort()
  }, [notify, refresh])

  const openAuthAssistant = async (site: Site, flow: AuthorizationFlow = 'standalone') => {
    try {
      const pairing = await api.createAuthAssistantPair(site.id)
      if (flow === 'channel-import') setPendingChannelImportSite(site)
      setAuthAssistantPair({ site, pairing })
      return true
    } catch (cause) {
      if (flow === 'channel-import') setPendingChannelImportSite(null)
      setChannelImportStatus({
        site,
        phase: 'error',
        operation: 'authorize',
        authorizationFlow: flow,
        message: cause instanceof Error ? cause.message : '无法生成本地授权配对信息',
      })
      return false
    }
  }

  const closeAuthAssistant = async () => {
    if (authAssistantPair) await api.cancelAuthAssistantPair(authAssistantPair.site.id, authAssistantPair.pairing.pairId).catch(() => undefined)
    setAuthAssistantPair(null)
    setPendingChannelImportSite(null)
  }

  const completeAuthAssistant = async (status: AuthAssistantPairingStatus) => {
    const activePair = authAssistantPair
    if (!activePair || status.status !== 'received') return
    const site = activePair.site
    await refresh(true)
    const pendingSite = pendingChannelImportSite
    if (pendingSite?.id === site.id) {
      setAuthAssistantPair(null)
      setPendingChannelImportSite(null)
      await continueChannelImport({ ...site, authStatus: 'valid' })
      return
    }
    notify('本地授权同步成功', `${site.name} 已记录本次授权，已同步 ${status.cookieCount} 个 Cookie、${status.localStorageCount} 个存储项`, 'success')
  }

  const runCheckin = async (siteIds?: number[]) => {
    try {
      await api.runCheckin(siteIds)
      notify('签到任务已提交', siteIds?.length === 1 ? '正在处理所选站点' : '正在依次处理全部启用站点')
      void refresh(true)
    } catch (cause) {
      notify('无法开始签到', cause instanceof Error ? cause.message : '未知错误', 'danger')
    }
  }

  async function prepareChannelImport(site: Site) {
    setChannelImportStatus({ site, phase: 'preparing', operation: 'prepare' })
    try {
      const result = await api.prepareChannelImport(site.id)
      if (!result.candidates.length) throw new Error('未提取到可导入的官方 API Key，请确认站点已登录并存在可用密钥。')
      setChannelImportStatus(null)
      setChannelImport({ site, candidates: result.candidates })
    } catch (cause) {
      await openChannelBalanceLink(site, cause instanceof Error ? cause.message : '未能读取完整的官方 API Key')
    }
  }

  async function openChannelBalanceLink(site: Site, reason: string) {
    setChannelImportStatus(null)
    try {
      const channels = await gatewayApi.channels().catch(() => gatewayChannels)
      setGatewayChannels(channels)
      setChannelBalanceLink({ site, channels, reason })
    } catch (cause) {
      setChannelImportStatus({
        site,
        phase: 'error',
        operation: 'link',
        message: cause instanceof Error ? cause.message : '无法读取现有渠道列表',
      })
    }
  }

  async function continueChannelImport(site: Site) {
    if (!supportsAutomaticChannelImport(site)) {
      await openChannelBalanceLink(site, '该站点没有可安全提取的官方 API Key；可关联已有渠道并同步签到余额。')
      return
    }
    await prepareChannelImport(site)
  }

  async function startChannelImport(site: Site) {
    if (site.authStatus === 'valid') {
      await continueChannelImport(site)
      return
    }

    await openAuthAssistant(site, 'channel-import')
  }

  const confirmChannelImport = async (input: { candidateId: string; name: string; models: string[]; priority: number; weight: number; tags: string[] }) => {
    if (!channelImport) return
    const site = channelImport.site
    setChannelImportStatus({ site, phase: 'confirming', operation: 'confirm' })
    try {
      const result = await api.confirmChannelImport(site.id, input)
      setImportedSiteIds((items) => items.includes(site.id) ? items : [...items, site.id])
      setChannelImport(null)
      setChannelImportStatus({ site, phase: 'success', operation: 'confirm', channel: result.channel, channelAction: result.action })
    } catch (cause) {
      setChannelImportStatus({
        site,
        phase: 'error',
        operation: 'confirm',
        message: cause instanceof Error ? cause.message : '无法写入渠道池',
      })
    }
  }

  const createManualChannel = async (input: {
    site: Site
    name: string
    keyName: string
    baseUrl: string
    apiKey: string
    protocol: Channel['protocol']
    models: string[]
    priority: number
    weight: number
    tags: string[]
  }) => {
    const site = input.site
    setChannelImportStatus({ site, phase: 'confirming', operation: 'create' })
    try {
      const imported = await gatewayApi.importProvider({
        name: input.name.trim(),
        channelName: input.name.trim(),
        keyName: input.keyName.trim() || 'API Key',
        baseUrl: input.baseUrl.trim(),
        apiKey: input.apiKey.trim(),
        protocol: input.protocol,
        models: input.models,
        priority: input.priority,
        weight: input.weight,
        tags: input.tags,
      })
      const linked = await api.linkChannelBalance(site.id, imported.channel.id)
      setImportedSiteIds((items) => items.includes(site.id) ? items : [...items, site.id])
      setChannelBalanceLink(null)
      await refresh(true)
      setChannelImportStatus({ site, phase: 'success', operation: 'create', channel: linked.channel })
    } catch (cause) {
      setChannelImportStatus({
        site,
        phase: 'error',
        operation: 'create',
        message: cause instanceof Error ? cause.message : '无法创建渠道并关联签到余额',
      })
    }
  }

  const confirmChannelBalanceLink = async (channelId: string) => {
    if (!channelBalanceLink) return
    const site = channelBalanceLink.site
    setChannelImportStatus({ site, phase: 'confirming', operation: 'link' })
    try {
      const result = await api.linkChannelBalance(site.id, channelId)
      setImportedSiteIds((items) => items.includes(site.id) ? items : [...items, site.id])
      setChannelBalanceLink(null)
      await refresh(true)
      setChannelImportStatus({ site, phase: 'success', operation: 'link', channel: result.channel })
    } catch (cause) {
      setChannelImportStatus({
        site,
        phase: 'error',
        operation: 'link',
        message: cause instanceof Error ? cause.message : '无法关联渠道并同步余额',
      })
    }
  }

  return (
    <section className="checkin-module">
      <div className="checkin-main-area">
        {loading && !state ? <LoadingScreen /> : error && !state ? <ErrorScreen message={error} retry={() => void refresh()} /> : state ? (
          <>
            {view === 'dashboard' && <Dashboard state={state} onAdd={() => setAddOpen(true)} onRun={runCheckin} onAuthorize={openAuthAssistant} onImport={startChannelImport} importedSiteIds={importedSiteIds} onSelect={setSelectedSite} onRefresh={() => refresh(true)} notify={notify} />}
            {view === 'history' && <HistoryView state={state} />}
            {view === 'settings' && <SettingsView settings={state.settings} onSaved={() => refresh(true)} notify={notify} />}
          </>
        ) : null}
      </div>

      {addOpen && <AddSiteModal onClose={() => setAddOpen(false)} onAdded={async (sites) => { setAddOpen(false); await refresh(true); if (sites.length === 1) void openAuthAssistant(sites[0]!) }} notify={notify} />}
      {authAssistantPair && <AuthAssistantModal site={authAssistantPair.site} pairing={authAssistantPair.pairing} onClose={() => void closeAuthAssistant()} onStatus={completeAuthAssistant} />}
      {channelImport && <ChannelImportModal site={channelImport.site} candidates={channelImport.candidates} onClose={() => setChannelImport(null)} onDiscoverModels={(candidateId) => api.discoverChannelImportModels(channelImport.site.id, candidateId)} onConfirm={confirmChannelImport} />}
      {channelBalanceLink && <ChannelBalanceLinkModal site={channelBalanceLink.site} channels={channelBalanceLink.channels} reason={channelBalanceLink.reason} onClose={() => setChannelBalanceLink(null)} onConfirm={confirmChannelBalanceLink} onCreate={createManualChannel} />}
      {channelImportStatus && <ChannelImportStatusModal status={channelImportStatus} onClose={() => setChannelImportStatus(null)} onRetry={() => {
        setChannelImportStatus(null)
        if (channelImportStatus.operation === 'authorize') {
          if (channelImportStatus.authorizationFlow === 'channel-import') {
            void startChannelImport(channelImportStatus.site)
          } else {
            void openAuthAssistant(channelImportStatus.site)
          }
        } else if (channelImportStatus.operation === 'prepare') {
          const site = channelImportStatus.site
          void prepareChannelImport(site)
        } else {
          setChannelImportStatus(null)
        }
      }} />}
      {selectedSite && state && <SiteDrawer site={selectedSite} results={state.recentResults.filter((result) => result.siteId === selectedSite.id)} authEvents={state.authSyncEvents.filter((event) => event.siteId === selectedSite.id)} onClose={() => setSelectedSite(null)} onRun={() => runCheckin([selectedSite.id])} onAuthorize={() => void openAuthAssistant(selectedSite)} />}
      <ToastRegion toasts={toasts} dismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </section>
  )
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  )
}

function Dashboard({ state, onAdd, onRun, onAuthorize, onImport, importedSiteIds, onSelect, onRefresh, notify }: {
  state: AppState
  onAdd: () => void
  onRun: (ids?: number[]) => void
  onAuthorize: (site: Site) => void
  onImport: (site: Site) => Promise<void>
  importedSiteIds: number[]
  onSelect: (site: Site) => void
  onRefresh: () => Promise<void>
  notify: (title: string, message: string, tone?: Toast['tone']) => void
}) {
  const busy = state.sites.some((site) => site.lastStatus === 'running')
  return (
    <div className="page">
      <PageHeader
        title="今日签到"
        description={formatDate()}
        actions={<>
          <button className="button secondary" onClick={onAdd}><Plus size={17} />添加站点</button>
          <button className="button primary" onClick={() => onRun()} disabled={busy}><Play size={17} fill="currentColor" />{busy ? '执行中' : '一键签到'}</button>
        </>}
      />
      <SummaryBand state={state} />
      <SitesView state={state} onRun={onRun} onAuthorize={onAuthorize} onImport={onImport} importedSiteIds={importedSiteIds} onSelect={onSelect} onRefresh={onRefresh} notify={notify} />
      <RecentActivityWithDeletions results={state.recentResults} deletions={state.recentDeletions ?? []} sites={state.sites} />
    </div>
  )
}

function SummaryBand({ state }: { state: AppState }) {
  const [attentionOpen, setAttentionOpen] = useState(false)
  const balancesRecorded = state.sites.filter((site) => site.lastBalanceAmount !== null).length
  const attentionSites = state.sites.filter((site) =>
    ['expired', 'manual_required', 'unknown'].includes(site.authStatus)
    || ['failed', 'manual_required'].includes(site.lastStatus),
  )
  const items: Array<{
    label: string
    value?: string
    values?: string[]
    hint: string
    tone: string
    action?: () => void
  }> = [
    { label: '今日进度', value: `${state.summary.successToday} / ${state.summary.enabledSites}`, hint: state.summary.failedToday ? `${state.summary.failedToday} 个失败` : '已完成站点', tone: 'green' },
    { label: '当前总额度', values: formatBalanceTotalItems(state.sites), hint: `已统计 ${balancesRecorded} / ${state.summary.totalSites} 个站点`, tone: 'blue' },
    { label: '今日奖励', values: formatRewardTotalItems(state.summary.rewardTodayByCurrency), hint: '按币种与流量单位分别汇总', tone: 'violet' },
    { label: '需处理', value: String(attentionSites.length), hint: '点击查看站点与错误原因', tone: attentionSites.length ? 'amber' : 'green', action: () => setAttentionOpen(true) },
    { label: '下次执行', value: state.summary.nextRunAt ? formatDateTime(state.summary.nextRunAt) : '未安排', hint: state.settings.scheduleEnabled ? `${state.settings.scheduleWindowStart} - ${state.settings.scheduleWindowEnd} 随机` : '自动签到已关闭', tone: 'blue' },
  ]
  return <>
    <section className="summary-band">{items.map((item) => <div className={`summary-item ${item.tone}`} key={item.label}><span>{item.label}</span>{item.values ? <div className="summary-totals">{item.values.length ? item.values.map((value) => <strong key={value}>{value}</strong>) : <strong>--</strong>}</div> : item.action ? <button className="summary-value-button" onClick={item.action} aria-label="查看需处理站点"><strong>{item.value}</strong><CircleAlert size={15} /></button> : <strong>{item.value}</strong>}<small>{item.hint}</small></div>)}</section>
    {attentionOpen && <AttentionModal sites={attentionSites} onClose={() => setAttentionOpen(false)} />}
  </>
}

function AttentionModal({ sites, onClose }: { sites: Site[]; onClose: () => void }) {
  return <Modal title="需处理站点" description={`${sites.length} 个站点需要检查登录、签到或网络状态`} onClose={onClose}>
    {sites.length ? <div className="attention-list">{sites.map((site) => <div className="attention-row" key={site.id}>
      <SiteAvatar site={site} />
      <div className="attention-main"><strong>{site.name}</strong><p>{site.lastError || (site.authStatus === 'unknown' ? '尚未完成登录授权' : '当前状态需要人工检查')}</p><small>{site.baseUrl}</small></div>
      <div className="attention-status"><StatusBadge tone={statusTone(site.authStatus)}>{authLabel(site.authStatus)}</StatusBadge><StatusBadge tone={statusTone(site.lastStatus)}>{checkinLabel(site.lastStatus)}</StatusBadge></div>
    </div>)}</div> : <EmptyState title="暂无需处理站点" description="当前登录与签到状态均正常。" />}
    <div className="modal-actions"><button className="button primary" onClick={onClose}>完成</button></div>
  </Modal>
}

function RecentActivityWithDeletions({ results, deletions, sites }: { results: CheckinResult[]; deletions: SiteDeletionLog[]; sites: Site[] }) {
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])
  const activities = useMemo(() => [
    ...results.map((result) => ({ kind: 'checkin' as const, timestamp: result.completedAt, result })),
    ...deletions.map((deletion) => ({ kind: 'deleted' as const, timestamp: deletion.deletedAt, deletion })),
  ].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)).slice(0, 8), [deletions, results])
  return (
    <section className="section-block activity-section">
      <div className="section-heading"><div><h2>最近执行</h2><p>签到任务的逐站结果与站点变更</p></div></div>
      {activities.length ? <div className="activity-list">{activities.map((activity) => activity.kind === 'deleted' ? (
        <div className="activity-row" key={`deleted-${activity.deletion.id}`}>
          <span className="activity-icon danger"><Trash2 size={14} /></span>
          <div><strong>{activity.deletion.siteName}</strong><p>{activity.deletion.message}</p><small className="activity-site-url">{activity.deletion.baseUrl}</small></div>
          <time>{formatDateTime(activity.deletion.deletedAt)}</time>
        </div>
      ) : (
        <div className="activity-row" key={`checkin-${activity.result.id}`}>
          <span className={`activity-icon ${statusTone(activity.result.status)}`}>{['success', 'already_checked'].includes(activity.result.status) ? <Check size={14} /> : activity.result.status === 'manual_required' ? <KeyRound size={14} /> : <CircleAlert size={14} />}</span>
          <div><strong>{activity.result.siteName}</strong><p>{activity.result.message}</p></div>
          {activity.result.rewardAmount !== null && <span className="activity-reward">{formatAmount(activity.result.rewardAmount, siteById.get(activity.result.siteId)?.currencySymbol ?? '$')}</span>}
          <time>{formatDateTime(activity.result.completedAt)}</time>
        </div>
      ))}</div> : <EmptyState title="暂无执行记录" description="完成首次签到后，结果会显示在这里。" />}
    </section>
  )
}

function RecentActivity({ results, sites }: { results: CheckinResult[]; sites: Site[] }) {
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])
  return (
    <section className="section-block activity-section">
      <div className="section-heading"><div><h2>最近执行</h2><p>签到任务的逐站结果</p></div></div>
      {results.length ? <div className="activity-list">{results.map((result) => (
        <div className="activity-row" key={result.id}>
          <span className={`activity-icon ${statusTone(result.status)}`}>{['success', 'already_checked'].includes(result.status) ? <Check size={14} /> : result.status === 'manual_required' ? <KeyRound size={14} /> : <CircleAlert size={14} />}</span>
          <div><strong>{result.siteName}</strong><p>{result.message}</p></div>
          {result.rewardAmount !== null && <span className="activity-reward">{formatAmount(result.rewardAmount, siteById.get(result.siteId)?.currencySymbol ?? '$')}</span>}
          <time>{formatDateTime(result.completedAt)}</time>
        </div>
      ))}</div> : <EmptyState title="暂无执行记录" description="完成首次签到后，结果会显示在这里。" />}
    </section>
  )
}

function SitesView({ state, onRun, onAuthorize, onImport, importedSiteIds, onSelect, onRefresh, notify }: {
  state: AppState
  onRun: (ids?: number[]) => void
  onAuthorize: (site: Site) => void
  onImport: (site: Site) => Promise<void>
  importedSiteIds: number[]
  onSelect: (site: Site) => void
  onRefresh: () => Promise<void>
  notify: (title: string, message: string, tone?: Toast['tone']) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'valid' | 'attention' | 'disabled'>('all')
  const [editingSite, setEditingSite] = useState<Site | null>(null)
  const [importingSiteId, setImportingSiteId] = useState<number | null>(null)
  const [refreshingBalanceSiteId, setRefreshingBalanceSiteId] = useState<number | null>(null)
  const sites = useMemo(() => state.sites.filter((site) => {
    const searchMatch = `${site.name} ${site.baseUrl} ${site.note}`.toLowerCase().includes(query.toLowerCase())
    const filterMatch = filter === 'all' || (filter === 'valid' && site.authStatus === 'valid') || (filter === 'attention' && (['expired', 'manual_required', 'unknown'].includes(site.authStatus) || ['failed', 'manual_required'].includes(site.lastStatus))) || (filter === 'disabled' && !site.enabled)
    return searchMatch && filterMatch
  }), [filter, query, state.sites])

  const toggle = async (site: Site) => {
    try {
      const updated = await api.updateSite(site.id, { enabled: !site.enabled })
      await onRefresh()
      notify(updated.enabled ? '自动签到已启用' : '自动签到已禁用', updated.name, 'success')
    } catch (cause) {
      notify('更新失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    }
  }
  const remove = async (site: Site) => {
    if (!window.confirm(`确定删除“${site.name}”及其签到记录吗？`)) return
    try {
      const result = await api.deleteSite(site.id)
      await onRefresh()
      if (result.warnings?.length) {
        notify('站点已删除', `${site.name}，部分运行时清理未完成，但站点数据已删除`, 'default')
      } else {
        notify('站点已删除', site.name)
      }
    } catch (cause) {
      notify('删除失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    }
  }

  const prepareImport = async (site: Site) => {
    setImportingSiteId(site.id)
    try {
      await onImport(site)
    } finally {
      setImportingSiteId(null)
    }
  }

  const refreshBalance = async (site: Site) => {
    if (refreshingBalanceSiteId !== null) return
    setRefreshingBalanceSiteId(site.id)
    try {
      const result = await api.syncChannelBalance(site.id)
      await onRefresh()
      notify(result.refreshed ? '余额已刷新' : '余额未刷新', result.result?.message ?? `${site.name} 暂未读取到最新余额`, result.refreshed ? 'success' : 'warning')
    } catch (cause) {
      notify('余额刷新失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    } finally {
      setRefreshingBalanceSiteId(null)
    }
  }

  return <>
    <section className="section-block site-management-section">
      <div className="section-heading"><div><h2>站点管理</h2><p>所有站点每分钟刷新；自动签到关闭后仍可手动操作</p></div><span>{state.summary.enabledSites} / {state.summary.totalSites} 个已启用</span></div>
      <div className="toolbar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、地址或备注" /></label>
        <label className="select-field"><span className="sr-only">状态筛选</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部状态</option><option value="valid">登录有效</option><option value="attention">需要处理</option><option value="disabled">自动签到已关闭</option></select><ChevronDown size={15} /></label>
        <span className="toolbar-count">{sites.length} 个站点</span>
      </div>
      <div className="table-wrap"><table className="data-table management-table"><thead><tr><th>站点</th><th>适配器</th><th>登录</th><th>签到</th><th>签到金额</th><th>当前余额</th><th>加入渠道</th><th>自动签到</th><th>操作</th></tr></thead><tbody>{sites.map((site) => <tr key={site.id}>
        <td><button className="site-cell" onClick={() => onSelect(site)}><SiteAvatar site={site} /><span><strong>{site.name}</strong><small>{site.baseUrl}</small>{site.note ? <small className="site-note" title={site.note}>备注：{site.note}</small> : null}</span></button></td>
        <td><span className="adapter-label">{siteAdapterLabel(site)}</span></td>
        <td><div className="site-auth-cell"><StatusBadge tone={statusTone(site.authStatus)}>{authLabel(site.authStatus)}</StatusBadge>{site.authSyncStatus === 'success' && site.authSyncedAt ? <small className="auth-sync-meta">已同步 {formatDateTime(site.authSyncedAt)}</small> : site.authSyncStatus === 'failed' ? <small className="auth-sync-meta danger-text" title={site.authSyncMessage ?? undefined}>同步失败</small> : null}</div></td>
        <td><StatusBadge tone={statusTone(site.lastStatus)}>{checkinLabel(site.lastStatus)}</StatusBadge></td>
        <td><div className="reward-cell"><strong className={site.lastStatus === 'disabled' ? rewardTimingTone(site.lastBalanceUpdatedAt) : rewardTimingTone(site.lastRewardAt)}>{formatAmount(site.lastRewardAmount, site.currencySymbol)}</strong><small className={site.lastStatus === 'disabled' ? balanceRefreshTimingClass(site.lastBalanceUpdatedAt) : undefined}>{site.lastStatus === 'disabled' ? balanceRefreshTimingLabel(site.lastBalanceUpdatedAt) : hasFreshBalanceRefresh(site, state.recentResults) ? '余额已刷新' : rewardTimingLabel(site.lastRewardAt)}</small></div></td>
        <td><div className="site-balance-cell"><button type="button" className={`site-balance-button balance-value ${site.lastBalanceAmount === null ? 'empty' : ''}`} title="点击刷新站点余额" disabled={refreshingBalanceSiteId !== null} onClick={(event) => { event.stopPropagation(); void refreshBalance(site) }}>{refreshingBalanceSiteId === site.id ? <RefreshCw size={13} className="spin" /> : null}<span>{formatBalance(site.lastBalanceAmount, site.currencySymbol)}</span></button><small className="balance-refresh-time">{formatBalanceRefreshTime(site.lastBalanceUpdatedAt)}</small></div></td>
        <td><StatusBadge tone={importedSiteIds.includes(site.id) ? 'success' : 'neutral'}>{importedSiteIds.includes(site.id) ? '是' : '否'}</StatusBadge></td>
        <td><div className="switch-control"><button className={`toggle ${site.enabled ? 'on' : ''}`} role="switch" aria-checked={site.enabled} aria-label={`${site.enabled ? '停用' : '启用'} ${site.name} 自动签到`} onClick={() => toggle(site)}><span /></button><small>{site.enabled ? '已启用' : '已禁用'}</small></div></td>
        <td><div className="row-actions"><IconButton title="编辑站点" onClick={() => setEditingSite(site)}><Pencil size={16} /></IconButton><IconButton title="授权" onClick={() => onAuthorize(site)}><KeyRound size={16} /></IconButton><IconButton title="立即签到" onClick={() => onRun([site.id])}><Play size={16} /></IconButton><IconButton title={importedSiteIds.includes(site.id) ? '重新导入渠道池' : site.authStatus !== 'valid' ? '点击后先授权，授权成功后继续接入渠道或关联余额' : supportsAutomaticChannelImport(site) ? '导入渠道池' : '关联已有渠道并同步余额'} disabled={importingSiteId === site.id} onClick={() => void prepareImport(site)}><ArrowDownToLine size={16} className={importingSiteId === site.id ? 'spin' : undefined} /></IconButton><IconButton title="删除" danger onClick={() => remove(site)}><Trash2 size={16} /></IconButton></div></td>
      </tr>)}</tbody></table></div>
    </section>
    {editingSite ? <EditSiteModal site={editingSite} onClose={() => setEditingSite(null)} onSaved={async () => { setEditingSite(null); await onRefresh() }} notify={notify} /> : null}
  </>
}

function HistoryView({ state }: { state: AppState }) {
  const [siteId, setSiteId] = useState('all')
  const siteById = useMemo(() => new Map(state.sites.map((site) => [site.id, site])), [state.sites])
  const results = siteId === 'all' ? state.recentResults : state.recentResults.filter((result) => result.siteId === Number(siteId))
  return <div className="page">
    <PageHeader title="签到记录" description="查看每次奖励、余额变化和失败原因" actions={<a className="button secondary" href={siteId === 'all' ? '/admin/checkin/export.csv' : `/admin/checkin/export.csv?siteId=${siteId}`}><Download size={17} />导出 CSV</a>} />
    <div className="toolbar"><label className="select-field"><select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="all">全部站点</option>{state.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select><ChevronDown size={15} /></label><span className="toolbar-count">最近 {results.length} 条</span></div>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>完成时间</th><th>站点</th><th>结果</th><th>签到奖励</th><th>签到前余额</th><th>签到后余额</th><th>余额变化</th><th>说明</th></tr></thead><tbody>{results.map((result) => {
      const site = siteById.get(result.siteId)
      const symbol = site?.currencySymbol ?? '$'
      return <tr key={result.id}><td>{formatDateTime(result.completedAt)}</td><td><strong>{result.siteName}</strong></td><td><StatusBadge tone={statusTone(result.status)}>{checkinLabel(result.status)}</StatusBadge></td><td className="amount positive">{formatAmount(result.rewardAmount, symbol)}</td><td>{formatBalance(result.balanceBeforeAmount, symbol)}</td><td>{formatBalance(result.balanceAfterAmount, symbol)}</td><td>{formatAmount(result.balanceDeltaAmount, symbol)}</td><td className="message-cell" title={result.message}>{result.message}</td></tr>
    })}</tbody></table>{!results.length && <EmptyState title="暂无记录" description="当前筛选条件下没有签到记录。" />}</div>
  </div>
}

function SettingsView({ settings, onSaved, notify }: { settings: AppSettings; onSaved: () => Promise<void>; notify: (title: string, message: string, tone?: Toast['tone']) => void }) {
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [testingTelegram, setTestingTelegram] = useState(false)
  useEffect(() => setDraft(settings), [settings])
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    try { await api.saveSettings(draft); await onSaved(); notify('设置已保存', '新的签到计划已经生效', 'success') } catch (cause) { notify('保存失败', cause instanceof Error ? cause.message : '未知错误', 'danger') } finally { setSaving(false) }
  }
  const requestNotifications = async () => {
    if (!('Notification' in window)) return notify('浏览器不支持通知', '请在站内查看签到结果', 'warning')
    const permission = await Notification.requestPermission()
    notify(permission === 'granted' ? '通知已启用' : '通知未启用', permission === 'granted' ? '自动签到完成后会显示浏览器通知' : '你可以稍后在浏览器设置中重新授权', permission === 'granted' ? 'success' : 'warning')
  }
  const testTelegram = async () => {
    setTestingTelegram(true)
    try {
      await api.testTelegram({ botToken: draft.telegramBotToken, chatId: draft.telegramChatId })
      notify('Telegram 测试成功', '测试消息已发送到目标会话', 'success')
    } catch (cause) {
      notify('Telegram 测试失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    } finally {
      setTestingTelegram(false)
    }
  }
  return <div className="page settings-page"><PageHeader title="设置" description="配置自动签到、重试和记录保留策略" />
    <form onSubmit={save}>
      <section className="settings-section"><div className="settings-intro"><CalendarDays size={19} /><div><h2>自动签到</h2><p>每天在时间窗口内随机选择一个执行时刻</p></div></div><div className="settings-fields">
        <SettingRow label="启用每日自动签到" hint="电脑和本地服务需要保持运行"><button type="button" className={`toggle ${draft.scheduleEnabled ? 'on' : ''}`} role="switch" aria-label="启用每日自动签到" aria-checked={draft.scheduleEnabled} onClick={() => setDraft({ ...draft, scheduleEnabled: !draft.scheduleEnabled })}><span /></button></SettingRow>
        <SettingRow label="执行时间窗口" hint="避免所有站点在同一固定时间收到请求"><div className="time-range"><input type="time" value={draft.scheduleWindowStart} onChange={(event) => setDraft({ ...draft, scheduleWindowStart: event.target.value })} /><span>至</span><input type="time" value={draft.scheduleWindowEnd} onChange={(event) => setDraft({ ...draft, scheduleWindowEnd: event.target.value })} /></div></SettingRow>
        <SettingRow label="时区" hint="首版固定使用中国标准时间"><select value={draft.timezone} disabled><option>Asia/Shanghai</option></select></SettingRow>
      </div></section>
      <section className="settings-section"><div className="settings-intro"><RefreshCw size={19} /><div><h2>失败处理</h2><p>网络错误自动重试，人机验证只提醒不绕过</p></div></div><div className="settings-fields">
        <SettingRow label="自动重试次数" hint="仅对普通网络或服务端失败生效"><NumberInput value={draft.retryCount} min={0} max={5} onChange={(value) => setDraft({ ...draft, retryCount: value })} suffix="次" /></SettingRow>
        <SettingRow label="重试间隔" hint="每次失败后的等待时间"><NumberInput value={draft.retryDelayMinutes} min={1} max={120} onChange={(value) => setDraft({ ...draft, retryDelayMinutes: value })} suffix="分钟" /></SettingRow>
        <SettingRow label="单次请求超时" hint="网络较慢时可适当增大"><NumberInput value={draft.requestTimeoutSeconds} min={10} max={120} onChange={(value) => setDraft({ ...draft, requestTimeoutSeconds: value })} suffix="秒" /></SettingRow>
      </div></section>
      <section className="settings-section"><div className="settings-intro"><Bell size={19} /><div><h2>通知与数据</h2><p>登录状态通过本地授权助手同步，并以加密快照保存</p></div></div><div className="settings-fields">
        <SettingRow label="浏览器通知" hint="页面打开时实时提示签到结果"><div className="inline-actions"><button type="button" className={`toggle ${draft.browserNotifications ? 'on' : ''}`} role="switch" aria-label="浏览器通知" aria-checked={draft.browserNotifications} onClick={() => setDraft({ ...draft, browserNotifications: !draft.browserNotifications })}><span /></button><button type="button" className="text-button" onClick={requestNotifications}>授权通知</button></div></SettingRow>
        <SettingRow label="历史记录保留" hint="过期记录会在保存设置时清理"><NumberInput value={draft.historyRetentionDays} min={30} max={3650} onChange={(value) => setDraft({ ...draft, historyRetentionDays: value })} suffix="天" /></SettingRow>
      </div></section>
      <section className="settings-section"><div className="settings-intro"><Send size={19} /><div><h2>Telegram 渠道</h2><p>每次签到任务结束后发送逐站结果汇总</p></div></div><div className="settings-fields">
        <SettingRow label="启用 Telegram 通知" hint="需先通过 BotFather 创建机器人"><button type="button" className={`toggle ${draft.telegramEnabled ? 'on' : ''}`} role="switch" aria-label="启用 Telegram 通知" aria-checked={draft.telegramEnabled} onClick={() => setDraft({ ...draft, telegramEnabled: !draft.telegramEnabled })}><span /></button></SettingRow>
        <SettingRow label="Bot Token" hint="机器人令牌仅保存在本机数据库"><input className="setting-input secret" type="password" autoComplete="off" aria-label="Telegram Bot Token" value={draft.telegramBotToken} onChange={(event) => setDraft({ ...draft, telegramBotToken: event.target.value })} placeholder="123456789:AA..." /></SettingRow>
        <SettingRow label="Chat ID" hint="可填写个人、群组或频道的会话 ID"><input className="setting-input" aria-label="Telegram Chat ID" value={draft.telegramChatId} onChange={(event) => setDraft({ ...draft, telegramChatId: event.target.value })} placeholder="-1001234567890" /></SettingRow>
        <SettingRow label="连接测试" hint="使用当前填写内容发送一条测试消息"><button type="button" className="button secondary compact" disabled={testingTelegram || !draft.telegramBotToken.trim() || !draft.telegramChatId.trim()} onClick={testTelegram}>{testingTelegram ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{testingTelegram ? '发送中' : '发送测试'}</button></SettingRow>
      </div></section>
      <div className="settings-footer"><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{saving ? '保存中' : '保存设置'}</button></div>
    </form>
  </div>
}

function AddSiteModal({ onClose, onAdded, notify }: { onClose: () => void; onAdded: (sites: Site[]) => void; notify: (title: string, message: string, tone?: Toast['tone']) => void }) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [faviconUrl, setFaviconUrl] = useState('')
  const [note, setNote] = useState('')
  const [bulk, setBulk] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true)
    try {
      if (mode === 'single') {
        const site = await api.addSite({
          ...(name ? { name } : {}),
          baseUrl: url,
          ...(note ? { note } : {}),
          faviconUrl: faviconUrl.trim() || null,
        })
        notify('站点已添加', '授权窗口即将打开')
        onAdded([site])
      } else {
        const urls = bulk.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
        const result = await api.addSitesBulk(urls)
        notify('批量导入完成', `新增 ${result.created.length} 个，跳过 ${result.skipped.length} 个`, result.created.length ? 'success' : 'warning')
        onAdded(result.created)
      }
    } catch (cause) { notify('添加失败', cause instanceof Error ? cause.message : '未知错误', 'danger') } finally { setSubmitting(false) }
  }
  return <Modal title="添加站点" description="支持 New API 新版和旧版面板" onClose={onClose}>
    <div className="segmented"><button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>单个添加</button><button className={mode === 'bulk' ? 'active' : ''} onClick={() => setMode('bulk')}>批量导入</button></div>
    <form onSubmit={submit} className="modal-form">
      {mode === 'single' ? <><label><span>站点地址</span><input autoFocus required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /></label><label><span>站点名称 <small>可选</small></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="授权后会自动读取站点名称" /></label><label><span>站点图标地址 <small>可选，留空自动获取</small></span><input type="url" value={faviconUrl} onChange={(event) => setFaviconUrl(event.target.value)} placeholder="https://example.com/favicon.ico" /></label><label><span>站点备注 <small>可选</small></span><textarea rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：仅手动签到、额度上限、账号用途" /></label><div className="info-note"><ShieldCheck size={17} /><p>添加后请在本地已登录目标站点的 Chrome/Edge 中使用 autoAPI 授权助手同步会话；服务端只保存加密后的登录快照。</p></div></> : <><label><span>站点地址，每行一个</span><textarea autoFocus required rows={9} value={bulk} onChange={(event) => setBulk(event.target.value)} placeholder={'https://site-one.example\nhttps://site-two.example'} /></label><div className="info-note"><ListChecks size={17} /><p>批量导入只创建站点。导入后请在站点管理中逐个完成首次授权。</p></div></>}
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}{mode === 'single' ? '添加并授权' : '导入站点'}</button></div>
    </form>
  </Modal>
}

function ChannelImportModal({ site, candidates, onClose, onDiscoverModels, onConfirm }: {
  site: Site
  candidates: ChannelImportPreview[]
  onClose: () => void
  onDiscoverModels: (candidateId: string) => Promise<{ protocol: string; models: string[]; error: string | null }>
  onConfirm: (input: { candidateId: string; name: string; models: string[]; priority: number; weight: number; tags: string[] }) => Promise<void>
}) {
  const [selectedCandidateId, setSelectedCandidateId] = useState(candidates[0]?.candidateId ?? '')
  const preview = candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? candidates[0]
  const [name, setName] = useState(site.name)
  const [priority, setPriority] = useState(0)
  const [weight, setWeight] = useState(100)
  const [tags, setTags] = useState('签到站点')
  const [saving, setSaving] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>(() => Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, candidate.models])))
  const [selectedModels, setSelectedModels] = useState<Record<string, string[]>>(() => Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, [] as string[]])))
  const [modelError, setModelError] = useState<string | null>(null)
  if (!preview) return null
  const availableModels = modelOptions[preview.candidateId] ?? []
  const chosenModels = selectedModels[preview.candidateId] ?? []

  const fetchModels = async () => {
    setLoadingModels(true)
    setModelError(null)
    try {
      const result = await onDiscoverModels(preview.candidateId)
      const models = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))]
      setModelOptions((current) => ({ ...current, [preview.candidateId]: models }))
      setSelectedModels((current) => {
        const currentSelection = current[preview.candidateId] ?? []
        return { ...current, [preview.candidateId]: currentSelection.filter((model) => models.includes(model)) }
      })
      if (result.error && models.length === 0) setModelError(result.error)
      else if (result.error) setModelError(`部分模型获取失败：${result.error}`)
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型列表获取失败')
    } finally {
      setLoadingModels(false)
    }
  }

  const toggleModel = (model: string) => {
    setSelectedModels((current) => {
      const selected = current[preview.candidateId] ?? []
      return { ...current, [preview.candidateId]: selected.includes(model) ? selected.filter((item) => item !== model) : [...selected, model] }
    })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await onConfirm({
        candidateId: preview.candidateId,
        name: name.trim(),
        models: chosenModels,
        priority,
        weight,
        tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      })
    } finally {
      setSaving(false)
    }
  }
  const protocolLabel = formatChannelProtocol(preview.protocol)
  const matchedChannel = preview.matchedChannel
  return <Modal title="导入渠道池" description="选择官方 API Key 基础信息，确认后直接写入渠道池，不执行模型或对话探测" onClose={onClose}>
    <form onSubmit={submit} className="modal-form channel-import-form">
      {matchedChannel ? <div className="channel-import-match matched"><CheckCircle2 size={16} /><div><strong>已按域名匹配现有渠道</strong><span>{matchedChannel.name} · {matchedChannel.baseUrl}</span><small>确认后将更新该渠道的 API Key、模型和渠道配置，不会新建重复渠道。</small></div></div> : <div className="channel-import-match pending"><Plus size={16} /><div><strong>未找到同域渠道</strong><span>确认后将按下面的基础信息新建渠道。</span><small>API Key 仍只会加密保存，导入不会自动执行探测请求。</small></div></div>}
      {candidates.length > 1 ? <fieldset className="key-choice-list"><legend>选择 API Key <small>{candidates.length} 条 Key 可用</small></legend>{candidates.map((candidate) => <label key={candidate.candidateId} className={`key-choice-item ${candidate.candidateId === preview.candidateId ? 'active' : ''}`}><input type="radio" name="channel-import-key" checked={candidate.candidateId === preview.candidateId} onChange={() => { setSelectedCandidateId(candidate.candidateId); setModelError(null) }} /><span><strong>{candidate.keyName}</strong><small>•••• {candidate.keyLast4}</small></span><CheckCircle2 size={16} /></label>)}</fieldset> : null}
      <div className="channel-import-summary">
        <div><span>渠道名称</span><strong>{site.name}</strong></div>
        <div><span>Base URL</span><strong title={preview.baseUrl}>{preview.baseUrl}</strong></div>
        <div><span>协议</span><strong>{protocolLabel}</strong></div>
        <div><span>API Key</span><strong>{preview.keyName} · •••• {preview.keyLast4}</strong></div>
        <div><span>导入状态</span><strong className="import-pending">未探测，待后续手动探测</strong></div>
      </div>
      <label><span>渠道名称</span><input required maxLength={120} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="model-fetch-row"><div><strong>模型列表</strong><small>{availableModels.length ? `已获取 ${availableModels.length} 个模型，已选 ${chosenModels.length} 个` : '拉取后请手动勾选要加入模型池的模型'}</small></div><button type="button" className="button secondary compact" onClick={() => void fetchModels()} disabled={loadingModels}>{loadingModels ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{loadingModels ? '获取中' : '拉取模型'}</button></div>
      {availableModels.length ? <fieldset className="model-check-list"><legend>选择模型 <small>请手动勾选后加入模型池</small></legend>{availableModels.map((model) => <label className="model-check-item" key={model}><input type="checkbox" checked={chosenModels.includes(model)} onChange={() => toggleModel(model)} /><span title={model}>{model}</span></label>)}</fieldset> : null}
      {modelError ? <div className="model-fetch-error"><CircleAlert size={15} /><span>{modelError}</span></div> : null}
      <div className="channel-import-grid"><label><span>优先级</span><input type="number" min={-100} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label><label><span>权重</span><input type="number" min={1} max={10000} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label></div>
      <label><span>标签 <small>多个标签用逗号分隔</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="签到站点" /></label>
      <div className="info-note"><ShieldCheck size={17} /><p>原始 API Key 只会加密保存到渠道库，页面和日志只显示尾号。导入不会调用上游模型接口，候选凭据将在 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 过期。</p></div>
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !name.trim() || (availableModels.length > 0 && chosenModels.length === 0)}>{saving ? <LoaderCircle size={17} className="spin" /> : matchedChannel ? <RefreshCw size={17} /> : <ArrowDownToLine size={17} />}{saving ? (matchedChannel ? '更新中' : '导入中') : (matchedChannel ? '确认更新渠道' : '确认新建渠道')}</button></div>
    </form>
  </Modal>
}

function ChannelBalanceLinkModal({ site, channels, reason, onClose, onConfirm, onCreate }: {
  site: Site
  channels: Channel[]
  reason: string
  onClose: () => void
  onConfirm: (channelId: string) => Promise<void>
  onCreate: (input: {
    site: Site
    name: string
    keyName: string
    baseUrl: string
    apiKey: string
    protocol: Channel['protocol']
    models: string[]
    priority: number
    weight: number
    tags: string[]
  }) => Promise<void>
}) {
  const sortedChannels = [...channels].sort((left, right) => Number(channelMatchesSite(right.baseUrl, site.baseUrl)) - Number(channelMatchesSite(left.baseUrl, site.baseUrl)))
  const [mode, setMode] = useState<'link' | 'create'>(() => sortedChannels.length ? 'link' : 'create')
  const [channelId, setChannelId] = useState(() => sortedChannels[0]?.id ?? '')
  const [name, setName] = useState(site.name)
  const [keyName, setKeyName] = useState('签到站点 API Key')
  const [baseUrl, setBaseUrl] = useState(site.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState<Channel['protocol']>('auto')
  const [priority, setPriority] = useState(0)
  const [weight, setWeight] = useState(100)
  const [tags, setTags] = useState('签到站点')
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const selected = sortedChannels.find((channel) => channel.id === channelId) ?? null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (mode === 'link' && !selected) return
    setSaving(true)
    try {
      if (mode === 'link') {
        await onConfirm(selected!.id)
      } else {
        await onCreate({
          site,
          name,
          keyName,
          baseUrl,
          apiKey,
          protocol,
          models: selectedModels,
          priority,
          weight,
          tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const fetchModels = async () => {
    setDiscovering(true)
    setModelError(null)
    try {
      const result = await gatewayApi.discoverModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), protocol, models: [] })
      const models = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))]
      setDiscoveredModels(models)
      setSelectedModels((current) => current.filter((model) => models.includes(model)))
      if (result.protocol !== 'auto' && protocol === 'auto') setProtocol(result.protocol as Channel['protocol'])
      if (result.error && models.length === 0) setModelError(result.error)
      else if (result.error) setModelError(`部分模型获取失败：${result.error}`)
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : '模型列表获取失败')
    } finally {
      setDiscovering(false)
    }
  }

  const toggleModel = (model: string) => setSelectedModels((current) => current.includes(model) ? current.filter((item) => item !== model) : [...current, model])

  return <Modal title={mode === 'link' ? '关联渠道并同步余额' : '手动创建渠道'} description={mode === 'link' ? '无法自动提取官方 API Key 时，仍可让已有渠道读取这个签到站的余额。' : '为该签到站手动提交 API Key，拉取模型后创建渠道并同步余额。'} onClose={onClose}>
    <div className="segmented channel-link-mode-tabs"><button type="button" className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>关联已有渠道</button><button type="button" className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>手动创建渠道</button></div>
    <form onSubmit={submit} className="modal-form channel-balance-link-form">
      <div className="channel-link-notice"><CircleAlert size={17} /><div><strong>未执行自动导入</strong><p>{reason}</p></div></div>
      <div className="channel-import-summary">
        <div><span>签到站点</span><strong>{site.name}</strong></div>
        <div><span>站点余额</span><strong>{formatBalance(site.lastBalanceAmount, site.currencySymbol)}</strong></div>
        <div><span>同步时机</span><strong>{site.lastBalanceAmount === null ? '下次签到或余额刷新后' : '确认后立即同步'}</strong></div>
      </div>
      {mode === 'link' && sortedChannels.length ? <>
        <label><span>选择已有渠道</span><select value={channelId} onChange={(event) => setChannelId(event.target.value)}>{sortedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}{channelMatchesSite(channel.baseUrl, site.baseUrl) ? '（同站点地址）' : ''}</option>)}</select></label>
        {selected ? <div className="channel-link-selected"><span>Base URL</span><strong title={selected.baseUrl}>{selected.baseUrl}</strong><span>模型数</span><strong>{selected.models.length}</strong></div> : null}
        <div className="info-note"><ShieldCheck size={17} /><p>此操作不会创建、读取或修改 API Key。它只保存站点与现有渠道的关联，并把签到站读取到的余额同步到渠道池；后续每次签到完成后会自动更新。</p></div>
      </> : mode === 'link' ? <div className="info-note"><CircleAlert size={17} /><p>当前没有可关联的渠道。可以切换到“手动创建渠道”，提交该站点的 API Key 并直接加入渠道池。</p></div> : <>
        <div className="channel-import-grid"><label><span>渠道名称</span><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>密钥名称</span><input maxLength={120} value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="例如：签到站点 Key" /></label></div>
        <label><span>Base URL</span><input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label><span>API Key</span><input required minLength={6} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="输入站点 API Key" /></label>
        <label><span>协议类型</span><select value={protocol} onChange={(event) => setProtocol(event.target.value as Channel['protocol'])}><option value="auto">自动识别</option><option value="openai">OpenAI 兼容</option><option value="claude">Claude 兼容</option><option value="gemini">Gemini 兼容</option><option value="new-api">New API</option><option value="sub2api">Sub2API</option></select></label>
        <div className="model-fetch-row"><div><strong>模型列表</strong><small>{discoveredModels.length ? `已获取 ${discoveredModels.length} 个模型，已选 ${selectedModels.length} 个` : '点击拉取后选择要加入模型池的模型'}</small></div><button type="button" className="button secondary compact" onClick={() => void fetchModels()} disabled={discovering || !baseUrl.trim() || !apiKey.trim()}>{discovering ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{discovering ? '获取中' : '拉取模型'}</button></div>
        {discoveredModels.length ? <fieldset className="model-check-list"><legend>选择模型 <small>勾选后加入模型池</small></legend>{discoveredModels.map((model) => <label className="model-check-item" key={model}><input type="checkbox" checked={selectedModels.includes(model)} onChange={() => toggleModel(model)} /><span title={model}>{model}</span></label>)}</fieldset> : null}
        {modelError ? <div className="model-fetch-error"><CircleAlert size={15} /><span>{modelError}</span></div> : null}
        <div className="channel-import-grid"><label><span>优先级</span><input type="number" min={-100} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label><label><span>权重</span><input type="number" min={1} max={10000} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label></div>
        <label><span>标签 <small>多个标签用逗号分隔</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="签到站点" /></label>
        <div className="info-note"><ShieldCheck size={17} /><p>API Key 会加密保存，页面只显示尾号。创建渠道不会执行对话探测；模型列表仅在点击“拉取模型”时读取。</p></div>
      </>}
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={saving || (mode === 'link' ? !selected : !name.trim() || !baseUrl.trim() || !apiKey.trim())}>{saving ? <LoaderCircle size={17} className="spin" /> : <ArrowDownToLine size={17} />}{saving ? (mode === 'link' ? '关联中' : '创建中') : (mode === 'link' ? '确认关联' : '创建并关联')}</button></div>
    </form>
  </Modal>
}

function ChannelImportStatusModal({ status, onClose, onRetry }: {
  status: ChannelImportStatus
  onClose: () => void
  onRetry: () => void
}) {
  const active = status.phase === 'preparing' || status.phase === 'confirming'
  const success = status.phase === 'success'
  const channelUpdated = status.channelAction === 'updated'
  const balanceLink = status.operation === 'link'
  const manualCreate = status.operation === 'create'
  const standaloneAuthorization = status.operation === 'authorize' && status.authorizationFlow !== 'channel-import'
  const title = active
    ? (balanceLink ? '正在关联渠道余额' : manualCreate ? '正在创建渠道' : status.operation === 'prepare' ? '正在准备导入' : '正在写入渠道池')
    : success
      ? (balanceLink ? '渠道余额已关联' : manualCreate ? '渠道创建成功' : channelUpdated ? '渠道更新成功' : '渠道导入成功')
      : status.operation === 'authorize' ? '站点授权失败' : balanceLink ? '渠道余额关联失败' : manualCreate ? '渠道创建失败' : '渠道导入失败'
  const description = active
    ? '请求正在处理，请稍候，不要重复点击导入按钮。'
    : success
      ? (balanceLink ? '签到站余额已绑定到所选渠道；后续签到完成后会继续同步。' : manualCreate ? '渠道基础信息和所选模型已保存，签到余额已完成关联。' : channelUpdated ? '已按站点域名匹配并更新原有渠道，没有创建重复渠道。' : '已创建新的渠道基础信息和模型配置，后续可在渠道管理中手动探测。')
    : standaloneAuthorization
      ? '本次授权没有完成，现有签到和渠道数据未被修改。'
      : '本次操作没有完成，现有签到数据和渠道数据未被清空。'

  const authStep = status.operation === 'authorize'
    ? active ? 'active' : 'failed'
    : 'done'
  const prepareStep = balanceLink || status.operation === 'authorize'
    ? ''
    : status.operation === 'prepare'
      ? active ? 'active' : 'failed'
      : 'done'
  const confirmStep = status.operation === 'confirm' || balanceLink || manualCreate
    ? active ? 'active' : success ? 'done' : 'failed'
    : ''

  return <Modal title={title} description={description} className="channel-import-status-modal" onClose={onClose} closeDisabled={active}>
    <div className={`channel-import-status ${status.phase}`}>
      <div className="channel-import-status-icon">
        {active ? <LoaderCircle size={24} className="spin" /> : success ? <CheckCircle2 size={24} /> : <CircleAlert size={24} />}
      </div>
      <div className="channel-import-status-copy">
        <strong>{status.site.name}</strong>
        <span>{status.site.baseUrl}</span>
      </div>
    </div>
    <div className="channel-import-progress" aria-live="polite">
      <div className={`channel-import-step ${authStep}`}>
        <span>{authStep === 'active' ? <LoaderCircle size={14} className="spin" /> : authStep === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}</span>
        <div><strong>授权登录站点</strong><small>{authStep === 'active' ? '请在授权窗口或浏览器入口完成登录' : authStep === 'failed' ? '授权未完成' : '已完成'}</small></div>
      </div>
      {!standaloneAuthorization ? <>
        <div className={`channel-import-step ${prepareStep}`}>
          <span>{prepareStep === 'active' ? <LoaderCircle size={14} className="spin" /> : prepareStep === 'failed' ? <CircleAlert size={14} /> : prepareStep === 'done' ? <Check size={14} /> : <Clock3 size={14} />}</span>
          <div><strong>读取并整理官方 API Key</strong><small>{prepareStep === 'active' ? '正在访问站点授权信息…' : prepareStep === 'failed' ? '未能完成 Key 提取' : prepareStep === 'done' ? '已完成' : '等待授权完成'}</small></div>
        </div>
        <div className={`channel-import-step ${confirmStep}`}>
          <span>{confirmStep === 'active' ? <LoaderCircle size={14} className="spin" /> : confirmStep === 'failed' ? <CircleAlert size={14} /> : confirmStep === 'done' ? <Check size={14} /> : <Clock3 size={14} />}</span>
          <div><strong>{balanceLink ? '关联渠道并同步余额' : manualCreate ? '创建渠道并同步余额' : '保存到渠道池'}</strong><small>{confirmStep === 'active' ? (balanceLink ? '正在保存关联并写入最新余额…' : manualCreate ? '正在加密保存渠道、模型并写入余额…' : '正在加密保存渠道凭据…') : confirmStep === 'failed' ? (balanceLink ? '关联失败，原有渠道未被修改' : manualCreate ? '创建或关联失败，请检查信息后重试' : '保存失败，渠道未成功导入') : confirmStep === 'done' ? '已完成' : '等待确认'}</small></div>
        </div>
      </> : null}
    </div>
    {status.message ? <div className="channel-import-error-detail"><CircleAlert size={16} /><p>{status.message}</p></div> : null}
    {status.channel ? <div className="channel-import-success-detail"><div><span>渠道名称</span><strong>{status.channel.name}</strong></div><div><span>Base URL</span><strong title={status.channel.baseUrl}>{status.channel.baseUrl}</strong></div><div><span>协议</span><strong>{formatChannelProtocol(status.channel.protocol)}</strong></div><div><span>API Key</span><strong>••••••••{status.channel.keyLast4}</strong></div><div><span>模型数</span><strong>{status.channel.models.length}</strong></div></div> : null}
    <div className="modal-actions channel-import-status-actions">
      {active ? <span className="channel-import-waiting"><LoaderCircle size={14} className="spin" />处理中，请稍候</span> : null}
      {!active && !success && status.operation === 'authorize' ? <button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} />重新授权</button> : null}
      {!active && !success && status.operation === 'prepare' ? <button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} />重新提取</button> : null}
      {!active && !success && status.operation === 'confirm' ? <button type="button" className="button secondary" onClick={onClose}>返回确认窗口</button> : null}
      {!active ? <button type="button" className="button primary" onClick={onClose}>{success ? '完成' : '关闭'}</button> : null}
    </div>
  </Modal>
}

function EditSiteModal({ site, onClose, onSaved, notify }: {
  site: Site
  onClose: () => void
  onSaved: (site: Site) => Promise<void>
  notify: (title: string, message: string, tone?: Toast['tone']) => void
}) {
  const [currentSite, setCurrentSite] = useState(site)
  const [name, setName] = useState(site.name)
  const [baseUrl, setBaseUrl] = useState(site.baseUrl)
  const [faviconUrl, setFaviconUrl] = useState(site.faviconUrl ?? '')
  const [note, setNote] = useState(site.note)
  const [enabled, setEnabled] = useState(site.enabled)
  const [saving, setSaving] = useState(false)
  const [refreshingIcon, setRefreshingIcon] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const form = new FormData(event.currentTarget as HTMLFormElement)
      const submittedFaviconUrl = faviconUrl.trim()
      const update: Parameters<typeof api.updateSite>[1] = {
        name: String(form.get('name') ?? ''),
        baseUrl: String(form.get('baseUrl') ?? ''),
        note: String(form.get('note') ?? ''),
        enabled,
      }
      if (submittedFaviconUrl !== (currentSite.faviconUrl ?? '')) update.faviconUrl = submittedFaviconUrl || null
      const updated = await api.updateSite(site.id, update)
      notify('站点信息已保存', updated.name, 'success')
      await onSaved(updated)
    } catch (cause) {
      notify('保存失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    } finally {
      setSaving(false)
    }
  }

  const refreshIcon = async () => {
    setRefreshingIcon(true)
    try {
      const updated = await api.refreshSiteFavicon(site.id)
      setCurrentSite(updated)
      setFaviconUrl(updated.faviconUrl ?? '')
      notify('站点图标已更新', updated.name, 'success')
    } catch (cause) {
      notify('图标更新失败', cause instanceof Error ? cause.message : '未知错误', 'danger')
    } finally {
      setRefreshingIcon(false)
    }
  }

  const addressChanged = baseUrl.trim().replace(/\/+$/, '') !== currentSite.baseUrl
  return <Modal title="编辑站点" description="修改基本信息和自动签到状态" onClose={onClose}>
    <form onSubmit={submit} className="modal-form">
      <div className="icon-editor">
        <SiteAvatar site={currentSite} large />
        <div><strong>站点真实图标</strong><p>可填写图标地址，也可从站点页面重新获取</p></div>
        <button type="button" className="button secondary compact" onClick={refreshIcon} disabled={refreshingIcon || addressChanged}>{refreshingIcon ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{refreshingIcon ? '获取中' : '重新获取'}</button>
      </div>
      <label><span>站点名称</span><input name="name" autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>站点地址</span><input name="baseUrl" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com" /></label>
      <label><span>站点图标地址 <small>清空后自动获取</small></span><input type="url" value={faviconUrl} onChange={(event) => setFaviconUrl(event.target.value)} placeholder="https://example.com/favicon.ico" /></label>
      <label><span>站点备注 <small>最多 500 字</small></span><textarea name="note" rows={4} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录账号用途、签到限制或其他说明" /></label>
      <div className="modal-switch-row"><div><strong>自动签到</strong><p>关闭后批量与定时任务会跳过，仍可手动签到、授权和刷新信息</p></div><button type="button" className={`toggle ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label="自动签到" onClick={() => setEnabled((value) => !value)}><span /></button></div>
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{saving ? '保存中' : '保存修改'}</button></div>
    </form>
  </Modal>
}

function AuthAssistantModal({ site, pairing, onClose, onStatus }: { site: Site; pairing: AuthAssistantPairing; onClose: () => void; onStatus: (status: AuthAssistantPairingStatus) => void }) {
  const onStatusRef = useRef(onStatus)
  const [assistantLaunch, setAssistantLaunch] = useState<{ phase: AssistantLaunchPhase; message: string }>({
    phase: 'starting',
    message: '正在唤起本地授权助手并打开浏览器登录页…',
  })
  const [status, setStatus] = useState<AuthAssistantPairingStatus>({
    pairId: pairing.pairId,
    siteId: site.id,
    status: 'waiting',
    code: pairing.code,
    domain: pairing.domain,
    expiresAt: pairing.expiresAt,
    claimedAt: null,
    receivedAt: null,
    cookieCount: 0,
    localStorageCount: 0,
    message: '等待本地 autoAPI 授权助手连接…',
  })

  useEffect(() => { onStatusRef.current = onStatus }, [onStatus])

  useEffect(() => {
    let active = true
    let receivedAssistantResponse = false
    const requestId = pairing.pairId
    const handleAssistantStatus = (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return
      const data = event.data as { type?: unknown; requestId?: unknown; phase?: unknown; message?: unknown }
      if (data.type !== 'autoapi-auth-assistant-status' || data.requestId !== requestId || !isAssistantLaunchPhase(data.phase) || typeof data.message !== 'string') return
      receivedAssistantResponse = true
      if (active) setAssistantLaunch({ phase: data.phase, message: data.message })
    }
    const unavailableTimer = window.setTimeout(() => {
      if (!active || receivedAssistantResponse) return
      setAssistantLaunch({
        phase: 'unavailable',
        message: '未检测到本地授权助手扩展。请确认已在当前 Chrome/Edge 配置文件中加载 autoAPI 授权助手。',
      })
    }, 2_500)

    window.addEventListener('message', handleAssistantStatus)
    window.postMessage({
      type: 'autoapi-auth-assistant-start',
      requestId,
      code: pairing.code,
      siteUrl: site.baseUrl,
      adapter: site.adapter,
    }, window.location.origin)

    return () => {
      active = false
      window.clearTimeout(unavailableTimer)
      window.removeEventListener('message', handleAssistantStatus)
    }
  }, [pairing.code, pairing.pairId, site.adapter, site.baseUrl])

  useEffect(() => {
    let active = true
    let completed = false
    let timer: number | null = null
    const poll = async () => {
      try {
        const next = await api.getAuthAssistantPair(site.id, pairing.pairId)
        if (!active) return
        setStatus(next)
        if (!completed && ['received', 'failed', 'expired', 'cancelled'].includes(next.status)) {
          completed = true
          if (timer !== null) window.clearInterval(timer)
          onStatusRef.current(next)
        }
      } catch (cause) {
        if (active) setStatus((current) => ({ ...current, status: 'failed', message: cause instanceof Error ? cause.message : '无法读取本地授权状态' }))
      }
    }
    void poll()
    timer = window.setInterval(() => void poll(), 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [pairing.pairId, site.id])

  const expired = ['expired', 'cancelled', 'failed'].includes(status.status)
  const title = status.status === 'received' ? '授权同步成功' : expired ? '授权未完成' : '本地授权助手'
  const statusLabel = status.status === 'received' ? '已同步并记录' : status.status === 'claimed' ? '助手已连接，等待上传' : expired ? '需要重新授权' : '等待授权助手连接'
  return <Modal title={title} description="使用 autoAPI 授权助手同步当前浏览器的站点登录状态" onClose={onClose}>
    <div className="assistant-auth-modal">
      <div className={`assistant-status assistant-status-panel ${status.status}`}><span className="assistant-status-dot" /><div><strong>{statusLabel}</strong><p>{status.message}</p></div></div>
      {status.status !== 'received' && !expired ? <div className={`assistant-status assistant-status-panel assistant-launch-status ${assistantLaunch.phase}`}><span className="assistant-status-dot" /><div><strong>{assistantLaunch.phase === 'opened' ? '已打开本地浏览器登录页' : assistantLaunch.phase === 'checking' ? '正在检查登录状态' : assistantLaunch.phase === 'waiting-login' ? '等待完成站点登录' : assistantLaunch.phase === 'synced' ? '登录状态已同步' : assistantLaunch.phase === 'unavailable' ? '未检测到本地授权助手' : assistantLaunch.phase === 'failed' ? '本地授权助手未能启动' : '正在启动本地授权助手'}</strong><p>{assistantLaunch.message}</p></div></div> : null}
      <div className="assistant-auth-facts"><div><span>目标站点</span><strong>{site.name}</strong></div><div><span>域名</span><strong>{pairing.domain}</strong></div><div><span>同步范围</span><strong>当前站点 Cookie + Local Storage</strong></div></div>
      <ol className="assistant-auth-steps"><li>本地授权助手会自动打开 {site.name} 的登录页。</li><li>在新打开的 Chrome/Edge 标签页完成登录，登录回跳后助手会自动同步。</li><li>保持此窗口打开，后台会自动记录同步成功或失败原因。</li></ol>
      <details className="assistant-auth-fallback">
        <summary>没有自动完成？在登录页手动同步</summary>
        <div className="assistant-auth-code"><span>备用授权码</span><strong>{pairing.code}</strong><small>在自动打开的登录页中打开扩展并点击“同步当前站点”。若助手未启动，可填写此码进行手动配对，有效期至 {formatDateTime(pairing.expiresAt)}</small></div>
      </details>
      {status.status === 'received' ? <p className="assistant-result">本次已同步 {status.cookieCount} 个 Cookie、{status.localStorageCount} 个 Local Storage 项，记录时间：{formatDateTime(status.receivedAt)}</p> : null}
      <p className="assistant-security-note">授权码和临时密钥仅用于本次配对，服务端不会保存明文 Cookie。</p>
    </div>
    <div className="modal-actions"><button type="button" className={`button ${expired || status.status === 'received' ? 'primary' : 'secondary'}`} onClick={onClose}>{status.status === 'waiting' || status.status === 'claimed' ? '取消授权' : '关闭'}</button></div>
  </Modal>
}

function SiteDrawer({ site, results, authEvents, onClose, onRun, onAuthorize }: { site: Site; results: CheckinResult[]; authEvents: AppState['authSyncEvents']; onClose: () => void; onRun: () => void; onAuthorize: () => void }) {
  return <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${site.name} 详情`}>
    <button className="drawer-backdrop" onClick={onClose} aria-label="关闭" />
    <aside className="drawer">
      <header><div><SiteAvatar site={site} large /><div><h2>{site.name}</h2><a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl}<ExternalLink size={13} /></a></div></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="drawer-actions"><button className="button primary" onClick={onRun}><Play size={16} />立即签到</button><button className="button secondary" onClick={onAuthorize}><KeyRound size={16} />重新授权</button></div>
      <dl className="site-facts"><div><dt>适配器</dt><dd>{siteAdapterLabel(site)}</dd></div><div><dt>登录账号</dt><dd>{site.username || '--'}</dd></div><div><dt>当前余额</dt><dd>{formatBalance(site.lastBalanceAmount, site.currencySymbol)}</dd></div><div><dt>最近签到</dt><dd>{formatDateTime(site.lastCheckedAt)}</dd></div></dl>
      {site.note ? <div className="drawer-note"><h3>站点备注</h3><p>{site.note}</p></div> : null}
      <div className="drawer-section"><h3>最近授权同步</h3>{authEvents.length ? authEvents.slice(0, 5).map((event) => <div className="drawer-result" key={event.id}><StatusBadge tone={event.status === 'success' ? 'success' : event.status === 'failed' ? 'danger' : 'neutral'}>{event.status === 'success' ? '同步成功' : event.status === 'failed' ? '同步失败' : event.status === 'claimed' ? '已连接' : '处理中'}</StatusBadge><span>{event.message}{event.status === 'success' ? `（${event.cookieCount} Cookie / ${event.localStorageCount} 存储）` : ''}</span><time>{formatDateTime(event.completedAt ?? event.startedAt)}</time></div>) : <p className="empty-inline">暂无授权记录</p>}</div>
      <div className="drawer-section"><h3>最近记录</h3>{results.length ? results.slice(0,10).map((result) => <div className="drawer-result" key={result.id}><StatusBadge tone={statusTone(result.status)}>{checkinLabel(result.status)}</StatusBadge><span>{result.message}</span><time>{formatDateTime(result.completedAt)}</time></div>) : <p className="empty-inline">暂无记录</p>}</div>
    </aside>
  </div>
}

function Modal({ title, description, onClose, closeDisabled = false, className = '', children }: { title: string; description?: string; onClose: () => void; closeDisabled?: boolean; className?: string; children: ReactNode }) {
  return createPortal(
    <div className="checkin-module checkin-modal-portal">
      <div className="checkin-modal-layer" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button className="checkin-modal-backdrop" onClick={closeDisabled ? undefined : onClose} aria-label="关闭弹窗" />
        <div className={`checkin-modal-dialog ${className}`.trim()}>
          <header><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><IconButton title={closeDisabled ? '处理中' : '关闭'} onClick={onClose} disabled={closeDisabled}><X size={18} /></IconButton></header>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function StatusBadge({ tone, children }: { tone: ReturnType<typeof statusTone>; children: ReactNode }) { return <span className={`status-badge ${tone}`}><span />{children}</span> }

function siteAdapterLabel(site: Site): string {
  if (site.lastBalanceAmount === null) return '待检测'
  if (site.adapter === 'new-api-modern') return 'New API 新版'
  if (site.adapter === 'new-api-legacy') return 'New API 旧版'
  if (site.adapter === 'local-api') return 'LocalAPI'
  if (site.adapter === 'sub2api') return 'Sub2API'
  if (site.adapter === 'fengwind-welfare') return 'Fengwind 福利站'
  if (site.adapter === 'hybgzs-welfare') return '黑与白福利站'
  if (site.adapter === 'chy-traffic') return 'CHY 流量签到'
  return '待检测'
}

function formatBalanceRefreshTime(value: string | null | undefined): string {
  return value ? `刷新于 ${formatDateTime(value)}` : '尚未刷新'
}

function hasFreshBalanceRefresh(site: Site, results: CheckinResult[]): boolean {
  const latest = results.find((result) => result.siteId === site.id)
  return Boolean(
    latest
      && latest.status === 'disabled'
      && latest.balanceAfterAmount !== null
      && /余额已刷新|余额刷新成功|balance.*refresh/i.test(latest.message),
  )
}

function balanceRefreshTimingLabel(value: string | null | undefined): string {
  return value ? `余额刷新于 ${rewardTimingLabel(value)}` : '暂无余额刷新记录'
}

function balanceRefreshTimingClass(value: string | null | undefined): string {
  const tone = rewardTimingTone(value)
  return tone === 'today' ? 'balance-refresh-today' : tone === 'previous' ? 'balance-refresh-previous' : 'balance-refresh-unknown'
}

function SiteAvatar({ site, large = false }: { site: Site; large?: boolean }) {
  const iconUrl = `/admin/checkin/sites/${site.id}/favicon?v=${encodeURIComponent(site.updatedAt)}`
  const [iconSrc, setIconSrc] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setIconSrc(null)
    setFailedUrl(null)
    void fetch(iconUrl, { headers: { Authorization: `Bearer ${localStorage.getItem('autoapi-admin-session') ?? ''}` } })
      .then((response) => {
        if (!response.ok) throw new Error('站点图标不可用')
        return response.blob()
      })
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setIconSrc(objectUrl)
      })
      .catch(() => {
        if (!active) return
        try {
          setIconSrc(site.faviconUrl || new URL('/favicon.ico', site.baseUrl).toString())
        } catch {
          setFailedUrl(iconUrl)
        }
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [iconUrl])

  const showFallback = failedUrl === iconUrl || !iconSrc
  return <span className={`site-avatar ${large ? 'large' : ''}`} aria-hidden="true">{showFallback
    ? site.name.slice(0, 1).toUpperCase()
    : <img src={iconSrc} alt="" loading="lazy" decoding="async" onError={() => { setIconSrc(null); setFailedUrl(iconUrl) }} />}
  </span>
}
function IconButton({ title, onClick, children, disabled, danger }: { title: string; onClick?: () => void; children: ReactNode; disabled?: boolean; danger?: boolean }) { return <button type="button" className={`icon-button ${danger ? 'danger' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button> }
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><ListChecks size={24} /><strong>{title}</strong><p>{description}</p></div> }
function LoadingScreen() { return <div className="center-screen"><LoaderCircle className="spin" size={28} /><p>正在读取本地数据</p></div> }
function ErrorScreen({ message, retry }: { message: string; retry: () => void }) { return <div className="center-screen error"><CircleAlert size={30} /><h2>无法打开签到台</h2><p>{message}</p><button className="button primary" onClick={retry}><RefreshCw size={16} />重试</button></div> }
function SettingRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong><p>{hint}</p></div><div>{children}</div></div> }
function NumberInput({ value, min, max, onChange, suffix }: { value: number; min: number; max: number; onChange: (value: number) => void; suffix: string }) { return <label className="number-input"><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /><span>{suffix}</span></label> }
function ToastRegion({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) { return <div className="toast-region" aria-live="polite">{toasts.map((toast) => <div className={`toast ${toast.tone}`} key={toast.id}><span>{toast.tone === 'success' ? <CheckCircle2 size={17} /> : toast.tone === 'danger' ? <CircleAlert size={17} /> : toast.tone === 'warning' ? <KeyRound size={17} /> : <Activity size={17} />}</span><div><strong>{toast.title}</strong><p>{toast.message}</p></div><button onClick={() => dismiss(toast.id)} aria-label="关闭通知"><X size={15} /></button></div>)}</div> }
