import { Fragment, lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, ChevronLeft, ChevronRight, CirclePlus, Clock3, Coins, Copy, GitBranch, Gauge, KeyRound, LogOut, Moon, RefreshCw, Route, Search, ShieldAlert, Sun, WalletCards, type LucideIcon } from "lucide-react";
import { ApiError, api, clearAdminSession, getAdminToken, hasAdminSession } from "./api";
import { ChannelTable } from "./components/ChannelTable";
import { ChannelEditor } from "./components/ChannelEditor";
import { MetricStrip } from "./components/MetricStrip";
import { ModelAliasDialog } from "./components/ModelAliasDialog";
import { Playground } from "./components/Playground";
import { ProviderDrawer } from "./components/ProviderDrawer";
import { ProbeResultDialog } from "./components/ProbeResultDialog";
import { GatewayKeyDialog } from "./components/GatewayKeyDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusDot } from "./components/StatusDot";
import type { AdminLoginRecord, Channel, GatewayStatus, Pool, ProbeResponse, RequestLogEntry, RequestLogPage, Usage, View } from "./types";
import CheckinModule, { CheckinTabs, type CheckinView } from "./checkin/CheckinModule";

const UsageChart = lazy(() => import("./components/UsageChart"));

type HealthWindow = "1h" | "6h" | "12h" | "24h" | "7d";
type HealthGroup = "default" | "status" | "requests";
type HealthScope = "all" | "available" | "abnormal" | "no-data";
type HealthSort = "available" | "requests";
type HealthTone = "available" | "degraded" | "abnormal" | "no-data";
type ColorTheme = "light" | "dark";

const colorThemeStorageKey = "autoapi-color-theme";
const activeViewStorageKey = "autoapi-active-view";
const activeCheckinViewStorageKey = "autoapi-active-checkin-view";

const appViews: View[] = ["overview", "channels", "pools", "usage", "requests", "playground", "checkin", "security"];
const checkinViews: CheckinView[] = ["dashboard", "history", "settings"];

function initialColorTheme(): ColorTheme {
  return localStorage.getItem(colorThemeStorageKey) === "dark" ? "dark" : "light";
}

function initialView(): View {
  const saved = localStorage.getItem(activeViewStorageKey);
  return saved && appViews.includes(saved as View) ? saved as View : "overview";
}

function initialCheckinView(): CheckinView {
  const saved = localStorage.getItem(activeCheckinViewStorageKey);
  return saved && checkinViews.includes(saved as CheckinView) ? saved as CheckinView : "dashboard";
}

export default function App() {
  const queryClient = useQueryClient();
  const [authenticated, setAuthenticated] = useState(() => hasAdminSession());
  const [colorTheme, setColorTheme] = useState<ColorTheme>(initialColorTheme);
  const [adminUsername, setAdminUsername] = useState("管理员");
  const [view, setView] = useState<View>(initialView);
  const [checkinView, setCheckinView] = useState<CheckinView>(initialCheckinView);
  const [usageWindow, setUsageWindow] = useState<Usage["window"]>("24h");
  const [providerOpen, setProviderOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [gatewayKeysOpen, setGatewayKeysOpen] = useState(false);
  const [baseUrlCopied, setBaseUrlCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [requestFilters, setRequestFilters] = useState<RequestFilters>({ window: "24h", limit: 20, offset: 0, client: "", channel: "", model: "", sourceIp: "" });
  const [requestRefreshInterval, setRequestRefreshInterval] = useState<number | false>(30_000);

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, enabled: authenticated, refetchInterval: 30_000 });
  const channels = useQuery({ queryKey: ["channels"], queryFn: api.channels, enabled: authenticated, refetchInterval: 30_000 });
  const pools = useQuery({ queryKey: ["pools"], queryFn: api.pools, enabled: authenticated, refetchInterval: 30_000 });
  const usage = useQuery({ queryKey: ["usage", usageWindow], queryFn: () => api.usage(usageWindow), enabled: authenticated, refetchInterval: 30_000 });
  const requests = useQuery({
    queryKey: ["requests", requestFilters],
    queryFn: () => api.requests(requestFilters),
    enabled: authenticated && view === "requests",
    refetchInterval: requestRefreshInterval,
    refetchIntervalInBackground: false,
  });
  const probe = useMutation({
    mutationFn: api.probe,
    onSuccess: (result) => {
      setProbeResult(result);
      void refreshAll(queryClient);
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "渠道探测失败，请重试。"),
  });
  const syncBalance = useMutation({
    mutationFn: (siteId: number) => api.syncCheckinSiteBalance(siteId),
    onSuccess: async (result) => {
      setActionError(null);
      setActionNotice(result.skippedBecauseBalanceIsUnknown ? "签到站暂无已知余额，未更新渠道余额。" : `已同步签到站余额，更新 ${result.updatedChannelIds.length} 个渠道。`);
      await refreshAll(queryClient);
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "签到站余额同步失败，请重试。");
    },
  });
  const refreshBalances = useMutation({
    mutationFn: api.refreshChannelBalances,
    onSuccess: async (result) => {
      setActionError(null);
      setActionNotice(`余额刷新完成：成功 ${result.summary.refreshed} 个，未知 ${result.summary.unknown} 个，失败 ${result.summary.failed} 个`);
      await refreshAll(queryClient);
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "批量刷新余额失败，请重试");
    },
  });
  const removeChannel = useMutation({
    mutationFn: api.deleteChannel,
    onSuccess: async () => {
      setActionError(null);
      await refreshAll(queryClient);
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "渠道删除失败，请重试。"),
  });
  const toggleChannel = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setChannelEnabled(id, enabled),
    onSuccess: () => void refreshAll(queryClient),
  });
  const reorderChannels = useMutation({
    mutationFn: (channelIds: string[]) => api.reorderChannels(channelIds),
    onSuccess: () => refreshAll(queryClient),
    onError: (error) => setActionError(error instanceof Error ? error.message : "渠道排序保存失败，请重试。"),
  });

  const authError = [status.error, channels.error, pools.error, usage.error, ...(view === "requests" ? [requests.error] : [])].find(
    (error) => error instanceof ApiError && error.status === 401,
  );
  const loading = status.isLoading || channels.isLoading || pools.isLoading || usage.isLoading || (view === "requests" && requests.isLoading);
  const failed = status.error ?? channels.error ?? pools.error ?? usage.error ?? (view === "requests" ? requests.error : null);
  const showLogin = !authenticated;

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    void api.me().then((result) => {
      if (active) setAdminUsername(result.username);
    }).catch((error: unknown) => {
      if (active && error instanceof ApiError && error.status === 401) {
        clearAdminSession();
        setAuthenticated(false);
      }
    });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !authError) return;
    clearAdminSession();
    queryClient.clear();
    setAuthenticated(false);
    setAdminUsername("管理员");
  }, [authenticated, authError, queryClient]);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    localStorage.setItem(colorThemeStorageKey, colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    localStorage.setItem(activeViewStorageKey, view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem(activeCheckinViewStorageKey, checkinView);
  }, [checkinView]);

  if (showLogin) return <LoginPage onAuthenticated={authenticatedSuccessfully} />;

  function refreshed() {
    void refreshAll(queryClient);
  }

  function authenticatedSuccessfully(username: string) {
    setAdminUsername(username);
    setAuthenticated(true);
    void queryClient.resetQueries();
  }

  function logout() {
    clearAdminSession();
    setAuthenticated(false);
    setAdminUsername("管理员");
    queryClient.clear();
  }

  function requestDelete(channel: Channel) {
    if (!window.confirm(`确定删除渠道“${channel.name}”吗？该渠道的模型路由也会被删除。`)) return;
    setActionError(null);
    removeChannel.mutate(channel.id);
  }

  function toggle(channel: Channel) {
    toggleChannel.mutate({ id: channel.id, enabled: !channel.enabled });
  }

  async function copyBaseUrl() {
    const value = status.data?.gatewayBaseUrl;
    if (!value) return;
    try {
      await copyText(value);
      setBaseUrlCopied(true);
      window.setTimeout(() => setBaseUrlCopied(false), 1800);
    } catch {
      setActionError("Base URL 复制失败，请手动复制。 ");
    }
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} />
      <main className="workspace">
        <header className={`topbar${view === "checkin" ? " topbar-checkin" : ""}`}>
          <div className="topbar-heading">
            {view !== "checkin" ? <div className="topbar-title">
              <span className="context-label">控制面板</span>
              <h1>{pageTitle(view)}</h1>
            </div> : null}
            {view === "checkin" ? <CheckinTabs view={checkinView} onChange={setCheckinView} /> : null}
          </div>
          <div className="top-actions">
            <div className="gateway-endpoint">
              <GatewayStatusIndicator status={status.data} isLoading={status.isLoading} error={status.error} />
              <span>网关 Base URL</span>
              <code className="mono">{status.data?.gatewayBaseUrl ?? "加载中…"}</code>
              <button className="icon-button" title={baseUrlCopied ? "已复制" : "复制 Base URL"} aria-label={baseUrlCopied ? "已复制" : "复制 Base URL"} onClick={() => void copyBaseUrl()} disabled={!status.data?.gatewayBaseUrl}>{baseUrlCopied ? <Check size={15} /> : <Copy size={15} />}</button>
            </div>
            <button className="icon-button theme-toggle" title={colorTheme === "light" ? "切换至深色模式" : "切换至浅色模式"} aria-label={colorTheme === "light" ? "切换至深色模式" : "切换至浅色模式"} onClick={() => setColorTheme((theme) => theme === "light" ? "dark" : "light")}>{colorTheme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button>
            <button className="button secondary key-button" onClick={() => setGatewayKeysOpen(true)}><KeyRound size={15} /> 访问密钥</button>
            <button className="button secondary security-button" onClick={() => setView("security")}><ShieldAlert size={15} /> {adminUsername}</button>
          </div>
        </header>
        {actionError ? <div className="action-error" role="alert">{actionError}</div> : null}
        {actionNotice ? <div className="action-notice" role="status">{actionNotice}</div> : null}

        {view === "checkin" ? <CheckinModule view={checkinView} /> : null}
        {view !== "checkin" && loading ? <LoadingState /> : null}
        {view !== "checkin" && failed && !authError ? <ErrorState error={failed} onRetry={refreshed} /> : null}
        {view !== "checkin" && !loading && !failed && status.data && channels.data && pools.data && usage.data ? (
          <>
            {view === "overview" ? <Overview status={status.data} channels={channels.data} pools={pools.data} usage={usage.data} syncingBalanceId={syncBalance.isPending ? syncBalance.variables ?? null : null} balanceRefreshPending={refreshBalances.isPending} onSyncBalance={syncBalance.mutate} probingId={probe.variables ?? null} onProbe={probe.mutate} onEdit={setEditingChannel} onDelete={requestDelete} onToggle={toggle} togglingId={toggleChannel.variables?.id ?? null} deletingId={removeChannel.isPending ? removeChannel.variables ?? null : null} onReorder={(ids) => reorderChannels.mutateAsync(ids).then(() => undefined)} /> : null}
            {view === "channels" ? <ChannelsView channels={channels.data} syncingBalanceId={syncBalance.isPending ? syncBalance.variables ?? null : null} balanceRefreshPending={refreshBalances.isPending} onSyncBalance={syncBalance.mutate} onRefreshBalances={() => refreshBalances.mutate()} probingId={probe.variables ?? null} onProbe={probe.mutate} onEdit={setEditingChannel} onDelete={requestDelete} onToggle={toggle} togglingId={toggleChannel.variables?.id ?? null} deletingId={removeChannel.isPending ? removeChannel.variables ?? null : null} onReorder={(ids) => reorderChannels.mutateAsync(ids).then(() => undefined)} onAddChannel={() => setProviderOpen(true)} /> : null}
            {view === "pools" ? <PoolsView pools={pools.data} onAddRoute={() => setAliasOpen(true)} /> : null}
            {view === "usage" ? <UsageView usage={usage.data} window={usageWindow} onWindowChange={setUsageWindow} /> : null}
            {view === "requests" ? <RequestsView page={requests.data} filters={requestFilters} refreshInterval={requestRefreshInterval} onRefreshIntervalChange={setRequestRefreshInterval} onFilterChange={(next) => setRequestFilters({ ...next, offset: 0 })} onRefresh={() => void requests.refetch()} onPageChange={(offset) => setRequestFilters((current) => ({ ...current, offset }))} /> : null}
            {view === "playground" ? <Playground channels={channels.data} onUpdated={refreshed} /> : null}
            {view === "security" ? <SecurityView username={adminUsername} onLogout={logout} /> : null}
          </>
        ) : null}
      </main>
      <ProviderDrawer open={providerOpen} onClose={() => setProviderOpen(false)} onCreated={refreshed} />
      <GatewayKeyDialog open={gatewayKeysOpen} onClose={() => setGatewayKeysOpen(false)} />
      <ChannelEditor channel={editingChannel} onClose={() => setEditingChannel(null)} onSaved={refreshed} />
      <ProbeResultDialog result={probeResult} onClose={() => setProbeResult(null)} />
      <ModelAliasDialog open={aliasOpen} channels={channels.data ?? []} onClose={() => setAliasOpen(false)} onCreated={refreshed} />
    </div>
  );
}

type GatewayIndicatorTone = "healthy" | "warning" | "error";

function GatewayStatusIndicator({ status, isLoading, error }: { status: GatewayStatus | undefined; isLoading: boolean; error: unknown }) {
  const indicator = getGatewayIndicator(status, isLoading, error);
  const channelSummary = status ? `${status.healthyChannels} / ${status.channels}` : "-";

  return (
    <span className={`gateway-status-indicator gateway-status-${indicator.tone}`} tabIndex={0} aria-label={`${indicator.label}，${indicator.description}`}>
      <span className="gateway-status-dot" aria-hidden="true" />
      <span className="gateway-status-tooltip" role="tooltip">
        <strong>{indicator.label}</strong>
        <span className="gateway-status-description">{indicator.description}</span>
        <span className="gateway-status-details">
          <span>可用渠道 <b>{channelSummary}</b></span>
          <span>模型池 <b>{status?.modelPools ?? "-"}</b></span>
          <span>近 1 小时错误率 <b>{status ? formatPercent(status.errorRate1h) : "-"}</b></span>
        </span>
      </span>
    </span>
  );
}

function getGatewayIndicator(status: GatewayStatus | undefined, isLoading: boolean, error: unknown): { tone: GatewayIndicatorTone; label: string; description: string } {
  if (error) {
    const message = error instanceof Error ? error.message : "无法连接管理状态接口";
    return { tone: "error", label: "网关异常", description: message };
  }
  if (isLoading || !status) return { tone: "warning", label: "正在检查", description: "正在获取网关运行状态" };
  if (status.status !== "ok") return { tone: "error", label: "网关异常", description: `服务返回状态：${status.status}` };
  if (status.channels === 0) return { tone: "warning", label: "尚未配置渠道", description: "网关服务正常，但还没有可路由渠道" };
  if (status.healthyChannels === 0) return { tone: "error", label: "网关异常", description: "网关服务正常，但当前没有健康渠道可供路由" };
  if (status.requests1h > 0 && status.errorRate1h >= 0.5) return { tone: "error", label: "请求异常", description: "近 1 小时请求错误率过高" };
  if (status.healthyChannels < status.channels) {
    const description = `网关服务正常，${status.isolatedChannels > 0 ? `${status.isolatedChannels} 个渠道已隔离` : "部分渠道正在检测或降级"}`;
    return { tone: "warning", label: "部分渠道异常", description };
  }
  if (status.requests1h > 0 && status.errorRate1h >= 0.1) return { tone: "warning", label: "请求异常偏高", description: "近 1 小时请求错误率偏高" };
  return { tone: "healthy", label: "网关正常", description: "网关服务和全部渠道运行正常" };
}

function Overview({
  status,
  channels,
  pools,
  usage,
  syncingBalanceId,
  balanceRefreshPending,
  onSyncBalance,
  probingId,
  onProbe,
  onEdit,
  onDelete,
  onToggle,
  togglingId,
  deletingId,
  onReorder,
}: {
  status: NonNullable<ReturnType<typeof api.status> extends Promise<infer T> ? T : never>;
  channels: Channel[];
  pools: Pool[];
  usage: Usage;
  syncingBalanceId: number | null;
  balanceRefreshPending: boolean;
  onSyncBalance: (siteId: number) => void;
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel) => void;
  togglingId: string | null;
  deletingId: string | null;
  onReorder: (channelIds: string[]) => Promise<void>;
}) {
  const [healthWindow, setHealthWindow] = useState<HealthWindow>("6h");
  const [healthGroup, setHealthGroup] = useState<HealthGroup>("default");
  const [healthScope, setHealthScope] = useState<HealthScope>("all");
  const [healthSort, setHealthSort] = useState<HealthSort>("requests");
  const visiblePools = pools.filter((pool) => healthScope === "all" || getPoolAvailability(pool, healthWindow).tone === healthScope);
  const sortedPools = sortPoolsForHealth(visiblePools, healthWindow, healthSort, healthGroup);
  const totalRequests = pools.reduce((sum, pool) => sum + getPoolHealthMetrics(pool, healthWindow).requests, 0);

  return (
    <div className="view-stack">
      <MetricStrip status={status} />
      <div className="overview-grid">
        <section className="surface traffic-surface">
          <SectionHead title="请求趋势" meta={`错误率 ${formatPercent(usage.errorRate)}`} />
          <Suspense fallback={<div className="chart-frame skeleton" />}><UsageChart usage={usage} /></Suspense>
        </section>
      </div>
      <section className="surface pool-health">
        <div className="pool-health-toolbar">
          <div className="pool-health-heading">
            <h2>模型健康度</h2>
            <span className="pool-health-total">监控 {visiblePools.length}/{pools.length} 个模型 · 总请求 {totalRequests.toLocaleString("zh-CN")}</span>
          </div>
          <span className="pool-health-refresh">每 60s 更新</span>
        </div>
        <div className="pool-health-filters">
          <label className="pool-health-filter">
            <span>时间范围</span>
            <select aria-label="健康度时间范围" value={healthWindow} onChange={(event) => setHealthWindow(event.target.value as HealthWindow)}>
              <option value="1h">近 1 小时</option>
              <option value="6h">近 6 小时</option>
              <option value="12h">近 12 小时</option>
              <option value="24h">近 24 小时</option>
              <option value="7d">近 7 天</option>
            </select>
          </label>
          <label className="pool-health-filter">
            <span>分组方式</span>
            <select aria-label="健康度分组方式" value={healthGroup} onChange={(event) => setHealthGroup(event.target.value as HealthGroup)}>
              <option value="default">默认分组</option>
              <option value="status">按状态分组</option>
              <option value="requests">按请求量分组</option>
            </select>
          </label>
          <label className="pool-health-filter">
            <span>模型范围</span>
            <select aria-label="健康度模型范围" value={healthScope} onChange={(event) => setHealthScope(event.target.value as HealthScope)}>
              <option value="all">全部模型</option>
              <option value="available">正常模型</option>
              <option value="abnormal">异常模型</option>
              <option value="no-data">暂无数据</option>
            </select>
          </label>
          <label className="pool-health-filter">
            <span>排序方式</span>
            <select aria-label="健康度排序方式" value={healthSort} onChange={(event) => setHealthSort(event.target.value as HealthSort)}>
              <option value="available">可用优先</option>
              <option value="requests">请求量优先</option>
            </select>
          </label>
        </div>
        <div className="pool-health-list">
          {pools.length === 0 ? <div className="empty-state compact"><Route size={18} /><span>暂无模型池，请添加渠道并选择模型。</span></div> : sortedPools.length === 0 ? <div className="empty-state compact"><Route size={18} /><span>当前筛选条件下暂无模型。</span></div> : sortedPools.map((pool) => <PoolHealthCard pool={pool} window={healthWindow} key={pool.alias} />)}
        </div>
        {pools.length > 0 ? <PoolHealthLegend /> : null}
      </section>
      <section className="surface">
        <SectionHead title="渠道运行情况" meta={`${channels.filter((channel) => channel.status === "isolated").length} 个已隔离`} />
        <ChannelTable channels={channels} syncingBalanceId={syncingBalanceId} balanceRefreshPending={balanceRefreshPending} onSyncBalance={onSyncBalance} probingId={probingId} onProbe={onProbe} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} togglingId={togglingId} deletingId={deletingId} onReorder={onReorder} />
      </section>
    </div>
  );
}

function PoolHealthCard({ pool, window }: { pool: Pool; window: HealthWindow }) {
  const availability = getPoolAvailability(pool, window);
  const metrics = getPoolHealthMetrics(pool, window);
  const config = getHealthWindowConfig(window);
  const successLabel = metrics.successRate === null ? "暂无请求" : `${formatPercent(metrics.successRate, 2)} 健康百分比`;
  return (
    <article className="pool-health-card">
      <div className="pool-health-head">
        <div className="pool-health-title">
          <strong className="mono">{pool.alias}</strong>
          <span className={`pool-health-status status-${availability.tone}`}>{availability.label}</span>
        </div>
        <div className="pool-health-summary">
          <strong>{successLabel}</strong>
          <span>{metrics.requests.toLocaleString("zh-CN")} 请求</span>
        </div>
      </div>
      <div className="pool-health-timeline">
        <HealthStrip points={metrics.points} durationMinutes={config.durationMinutes} label={`${pool.alias} ${config.label}健康状态`} />
      </div>
      <div className="pool-health-metrics">
        <span>{config.startLabel}</span>
        <span>{config.middleLabel}</span>
        <span>现在</span>
      </div>
    </article>
  );
}

function HealthStrip({ points, durationMinutes, label }: { points: Pool["recentHealth"]; durationMinutes: number; label: string }) {
  const [hoveredBucket, setHoveredBucket] = useState<string | null>(null);
  return <div className="pool-health-strip" style={{ gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))` }} aria-label={label}>
    {points.map((point) => {
      const tooltip = formatHealthPointTooltip(point, durationMinutes);
      const hovered = hoveredBucket === point.bucket;
      return <span className={`pool-health-cell-wrap${hovered ? " is-hovered" : ""}`} key={point.bucket} tabIndex={0} onMouseEnter={() => setHoveredBucket(point.bucket)} onMouseLeave={() => setHoveredBucket(null)} onFocus={() => setHoveredBucket(point.bucket)} onBlur={() => setHoveredBucket(null)}>
        <span className={`pool-hour-cell hour-${point.status}`} aria-label={tooltip} />
        <span className="pool-health-tooltip" role="tooltip" aria-hidden={!hovered}>
          <strong>{formatHealthRange(point.bucket, durationMinutes)}</strong>
          <span>总请求 <b>{point.requests}</b></span>
          <span>成功数 <b>{point.successfulRequests}</b></span>
          <span>健康百分比 <b>{point.successRate === null ? "—" : formatPercent(point.successRate, 2)}</b></span>
        </span>
      </span>;
    })}
  </div>;
}

function PoolHealthLegend() {
  return (
    <div className="pool-health-legend" aria-label="健康状态图例">
      <span><i className="legend-swatch hour-available" /> 可用 ≥95%</span>
      <span><i className="legend-swatch hour-degraded" /> 降级 80–95%</span>
      <span><i className="legend-swatch hour-abnormal" /> 异常 &lt;80%</span>
      <span><i className="legend-swatch hour-no_request" /> 无请求</span>
    </div>
  );
}

function ChannelsView({ channels, syncingBalanceId, balanceRefreshPending, onSyncBalance, onRefreshBalances, probingId, onProbe, onEdit, onDelete, onToggle, togglingId, deletingId, onReorder, onAddChannel }: { channels: Channel[]; syncingBalanceId: number | null; balanceRefreshPending: boolean; onSyncBalance: (siteId: number) => void; onRefreshBalances: () => void; probingId: string | null; onProbe: (id: string) => void; onEdit: (channel: Channel) => void; onDelete: (channel: Channel) => void; onToggle: (channel: Channel) => void; togglingId: string | null; deletingId: string | null; onReorder: (channelIds: string[]) => Promise<void>; onAddChannel: () => void }) {
  return (
    <div className="view-stack">
      <section className="channel-summary">
        <div><span>已知余额</span><strong>{formatKnownBalance(channels)}</strong></div>
        <div><span>余额未知</span><strong>{channels.filter((item) => item.balance === null).length}</strong></div>
        <div><span>冷却中</span><strong>{channels.filter((item) => item.cooldownUntil).length}</strong></div>
        <div><span>近 15 分钟请求</span><strong>{channels.reduce((sum, item) => sum + item.recentRequestCount, 0).toLocaleString("zh-CN")}</strong></div>
      </section>
      <section className="surface">
        <SectionHead title="全部渠道" meta="实时健康状态与余额" action={<div className="section-head-actions"><button className="button secondary" onClick={onRefreshBalances} disabled={balanceRefreshPending}><WalletCards size={15} className={balanceRefreshPending ? "spin" : ""} /> {balanceRefreshPending ? "刷新中" : "批量刷新余额"}</button><button className="button primary" onClick={onAddChannel}><CirclePlus size={15} /> 添加渠道</button></div>} />
        <ChannelTable channels={channels} syncingBalanceId={syncingBalanceId} balanceRefreshPending={balanceRefreshPending} onSyncBalance={onSyncBalance} probingId={probingId} onProbe={onProbe} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} togglingId={togglingId} deletingId={deletingId} onReorder={onReorder} />
      </section>
      <section className="surface detail-list">
        <SectionHead title="隔离详情" meta="自动熔断状态" />
        {channels.filter((channel) => channel.status === "isolated" || channel.status === "degraded").map((channel) => (
          <div className="detail-row" key={channel.id}>
            <ShieldAlert size={17} />
            <div><strong>{channel.name}</strong><span>{translateReason(channel.isolationReason)}</span></div>
            <span>连续失败 {channel.consecutiveFailures} 次</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function PoolsView({ pools, onAddRoute }: { pools: Pool[]; onAddRoute: () => void }) {
  const [expandedAliases, setExpandedAliases] = useState<Set<string>>(new Set());

  function toggleExpanded(alias: string) {
    setExpandedAliases((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  return (
    <div className="view-stack">
      <section className="surface">
          <SectionHead title="模型池" meta={`${pools.length} 个模型，${pools.reduce((sum, pool) => sum + pool.routes.length, 0)} 条渠道路由`} action={<button className="button secondary" onClick={onAddRoute}><GitBranch size={15} /> 添加路由</button>} />
        <div className="pool-table-scroll">
          <table className="pool-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>可用渠道</th>
                <th>最近 1 小时</th>
                <th>健康百分比</th>
                <th>平均延迟</th>
                <th>上游路由</th>
              </tr>
            </thead>
            <tbody>
              {pools.length === 0 ? <tr><td className="empty-table-cell" colSpan={6}>暂无模型池。添加渠道并选择模型后，模型会进入池。</td></tr> : pools.map((pool) => {
                const expanded = expandedAliases.has(pool.alias);
                const routes = sortPoolRoutesByLastRequest(pool.routes);
                const hasMultipleChannels = routes.length > 1;
                return (
                <Fragment key={pool.alias}>
                  <tr className={`pool-table-row ${expanded ? "expanded" : ""}`.trim()}>
                    <td>
                      <div className="pool-model-name">
                        <Route size={16} />
                        <span className="mono">{pool.alias}</span>
                      </div>
                    </td>
                    <td>
                      <strong className="pool-health-count">{pool.healthyChannels}/{pool.channels}</strong>
                    </td>
                    <td>{pool.totalRequests1h.toLocaleString("zh-CN")} 次</td>
                    <td className={pool.totalRequests1h === 0 ? "subtle" : pool.errorRate1h > 0.2 ? "danger-text" : pool.errorRate1h > 0.05 ? "warning-text" : "success-text"}>{pool.totalRequests1h === 0 ? "—" : formatPercent(1 - pool.errorRate1h)}</td>
                    <td>{pool.averageLatencyMs1h} ms</td>
                    <td>
                      <div className="pool-route-cell">
                        <button className="pool-expand-button" type="button" onClick={() => toggleExpanded(pool.alias)} aria-expanded={expanded} disabled={!hasMultipleChannels}>
                          <span className="pool-expand-icon" aria-hidden="true">{hasMultipleChannels ? (expanded ? "−" : "+") : "·"}</span>
                          <span>{hasMultipleChannels ? (expanded ? `收起 ${routes.length} 个渠道` : `${routes.length} 个渠道`) : "1 个渠道"}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded ? <tr className="pool-route-detail-row">
                    <td className="pool-route-detail-cell" colSpan={6}>
                      <div className="pool-route-list">
                        {routes.map((route) => (
                          <div className="pool-route-item" key={`${route.channelId}-${route.upstreamModel}`}>
                            <div className="pool-route-main">
                              <span className="pool-route-meta pool-route-conversation" title="最近 1 小时真实请求的平均响应耗时">
                                <span>对话延迟</span>
                                <strong>{formatLatency(route.conversationLatencyMs)}</strong>
                              </span>
                              <span className="pool-route-meta pool-route-ping" title="渠道最近一次健康探测的端点响应耗时">
                                <span>端点 PING</span>
                                <strong>{formatLatency(route.endpointPingMs)}</strong>
                              </span>
                            </div>
                            <div className="pool-route-health" aria-label={`${route.channelName} 近 24 小时每小时状态`}>
                              <div className="pool-route-identity">
                                <PoolRouteSiteIcon route={route} />
                                <span className="pool-route-channel" title={route.channelName}>{route.channelName}</span>
                                <StatusDot status={route.status} />
                              </div>
                              <div className="pool-route-hour-grid">
                                {route.hourlyHealth.map((point) => (
                                  <span className="pool-route-hour-wrap" key={point.bucket} tabIndex={0} aria-label={formatHealthTooltip(point)}>
                                    <span className={`pool-hour-cell hour-${point.status}`} aria-hidden="true" />
                                    <span className="pool-route-health-tooltip" role="tooltip">
                                      <strong>{formatHealthRange(point.bucket, 60)}</strong>
                                      <span>状态 <b>{formatHealthStatus(point.status)}</b></span>
                                      <span>请求数 <b>{point.requests}</b></span>
                                      <span>成功数 <b>{point.successfulRequests}</b></span>
                                      <span>健康百分比 <b>{point.successRate === null ? "—" : formatPercent(point.successRate, 1)}</b></span>
                                    </span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr> : null}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PoolRouteSiteIcon({ route }: { route: Pool["routes"][number] }) {
  return <ChannelSiteIcon channelId={route.channelId} channelName={route.channelName} className="pool-route-site-icon" />;
}

function sortPoolRoutesByLastRequest(routes: Pool["routes"]): Pool["routes"] {
  return [...routes].sort((a, b) => {
    const lastRequestDifference = (Date.parse(b.lastRequestedAt ?? "") || 0) - (Date.parse(a.lastRequestedAt ?? "") || 0);
    if (lastRequestDifference !== 0) return lastRequestDifference;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.channelName.localeCompare(b.channelName, "zh-CN");
  });
}

function ChannelSiteIcon({ channelId, channelName, className }: { channelId: string | null; channelName: string; className: string }) {
  const iconUrl = channelId ? `/admin/channels/${encodeURIComponent(channelId)}/favicon` : null;
  const [iconSrc, setIconSrc] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setIconSrc(null);
    setUnavailable(!iconUrl);

    if (!iconUrl) return () => {
      active = false;
      controller.abort();
    };

    void fetch(iconUrl, {
      cache: "force-cache",
      headers: { Authorization: `Bearer ${getAdminToken()}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("channel icon unavailable");
        return response.blob();
      })
      .then((blob) => {
        if (!blob.size) throw new Error("channel icon is empty");
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setIconSrc(objectUrl);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [iconUrl]);

  if (!channelId) return null;

  return (
    <span className={className} title={`${channelName} 站点图标`} aria-hidden="true">
      {unavailable || !iconSrc
        ? <span>{channelName.slice(0, 1).toUpperCase()}</span>
        : <img src={iconSrc} alt="" loading="lazy" decoding="async" onError={() => { setIconSrc(null); setUnavailable(true); }} />}
    </span>
  );
}

function UsageViewLegacy({ usage, window, onWindowChange }: { usage: Usage; window: Usage["window"]; onWindowChange: (window: Usage["window"]) => void }) {
  return (
    <div className="view-stack">
      <div className="usage-toolbar">
        <div className="segmented" aria-label="用量时间范围">{(["1h", "24h", "7d"] as const).map((value) => <button className={window === value ? "active" : ""} key={value} onClick={() => onWindowChange(value)}>{value}</button>)}</div>
        <span>{(usage.promptTokens + usage.completionTokens).toLocaleString("zh-CN")} 令牌</span>
      </div>
      <section className="surface usage-chart-large">
        <SectionHead title="请求与失败" meta={`共 ${usage.totalRequests} 次`} />
        <Suspense fallback={<div className="chart-frame skeleton" />}><UsageChart usage={usage} /></Suspense>
      </section>
      <div className="two-columns">
        <UsageBreakdown title="按模型" rows={usage.byModel} />
        <UsageBreakdown title="按渠道" rows={usage.byChannel} />
        <UsageBreakdown title="按客户端" rows={usage.byClient} />
        <UsageBreakdown title="失败原因" rows={usage.byError} />
      </div>
    </div>
  );
}

type UsageTab = "models" | "channels" | "clients";

function UsageView({ usage, window, onWindowChange }: { usage: Usage; window: Usage["window"]; onWindowChange: (window: Usage["window"]) => void }) {
  const [tab, setTab] = useState<UsageTab>("models");
  const totalTokens = usage.promptTokens + usage.completionTokens;
  const successRate = usage.totalRequests === 0 ? null : usage.successfulRequests / usage.totalRequests;
  const rows = tab === "models" ? usage.byModel : tab === "channels" ? usage.byChannel : usage.byClient;
  const tabLabels: Record<UsageTab, string> = { models: "模型统计", channels: "渠道统计", clients: "客户端统计" };
  const periodLabel = getUsagePeriodLabel(window);

  return (
    <div className="view-stack usage-view">
      <div className="usage-page-heading">
        <div>
          <h2>使用统计</h2>
          <p>查看 AI 模型的 Token、请求和渠道使用情况</p>
        </div>
        <div className="usage-page-controls">
          <div className="segmented usage-window-control" role="group" aria-label="统计时间范围">
            {(["1h", "24h", "7d"] as const).map((value) => (
              <button className={window === value ? "active" : ""} key={value} type="button" onClick={() => onWindowChange(value)}>
                {value === "1h" ? "1 小时" : value === "24h" ? "今天" : "7 天"}
              </button>
            ))}
          </div>
          <span className="usage-period-label">{periodLabel}</span>
        </div>
      </div>

      <section className="surface usage-summary-panel">
        <div className="usage-primary-stat">
          <span className="usage-stat-icon tone-blue"><Coins size={18} /></span>
          <div>
            <span>总 Token</span>
            <strong>{formatTokens(totalTokens)}</strong>
            <small>{totalTokens.toLocaleString("zh-CN")} tokens</small>
          </div>
        </div>
        <div className="usage-stat-grid">
          <UsageStat label="输入" value={formatTokens(usage.promptTokens)} detail="输入 Token" icon={Route} tone="blue" />
          <UsageStat label="输出" value={formatTokens(usage.completionTokens)} detail="输出 Token" icon={Activity} tone="green" />
          <UsageStat label="请求次数" value={usage.totalRequests.toLocaleString("zh-CN")} detail={`${usage.successfulRequests.toLocaleString("zh-CN")} 次成功`} icon={Gauge} tone="ink" />
          <UsageStat label="健康百分比" value={successRate === null ? "—" : formatPercent(successRate, 1)} detail={`${usage.errorRate ? `${formatPercent(usage.errorRate, 1)} 错误` : "暂无错误"}`} icon={WalletCards} tone="green" />
          <UsageStat label="平均耗时" value={formatDuration(usage.averageLatencyMs)} detail="端到端请求耗时" icon={Clock3} tone="amber" />
        </div>
      </section>

      <section className="surface usage-trend-panel">
        <div className="usage-panel-heading">
          <div>
            <h2>使用趋势</h2>
            <p>按时间查看请求和失败变化</p>
          </div>
          <span>{usage.totalRequests.toLocaleString("zh-CN")} 次请求</span>
        </div>
        <div className="usage-chart-legend" aria-label="图表图例">
          <span><i className="usage-legend-dot requests" />请求次数</span>
          <span><i className="usage-legend-dot errors" />失败次数</span>
        </div>
        <Suspense fallback={<div className="chart-frame skeleton" />}><UsageChart usage={usage} /></Suspense>
      </section>

      <section className="surface usage-details-panel">
        <div className="usage-tabs" role="tablist" aria-label="使用统计分类">
          {(Object.keys(tabLabels) as UsageTab[]).map((value) => (
            <button className={tab === value ? "active" : ""} key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {tabLabels[value]}
            </button>
          ))}
        </div>
        <div className="usage-details-toolbar">
          <div><h2>{tabLabels[tab]}</h2><span>按请求次数排序</span></div>
          <span>{rows.length} 个统计项</span>
        </div>
        <UsageDetailTable rows={rows} totalRequests={usage.totalRequests} />
      </section>

      {usage.byError.length > 0 ? (
        <section className="usage-error-summary" aria-label="错误原因">
          <strong>主要错误原因</strong>
          {usage.byError.slice(0, 3).map((row) => <span key={row.name}><b>{row.name}</b>{row.requests} 次</span>)}
        </section>
      ) : null}
    </div>
  );
}

function UsageStat({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: LucideIcon; tone: "blue" | "green" | "ink" | "amber" }) {
  return <div className="usage-stat"><span className={`usage-stat-icon tone-${tone}`}><Icon size={16} /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function UsageDetailTable({ rows, totalRequests }: { rows: Usage["byModel"]; totalRequests: number }) {
  if (rows.length === 0) return <div className="usage-empty"><Search size={20} /><strong>暂无统计数据</strong><span>有请求经过网关后，这里会显示真实使用情况。</span></div>;
  return <div className="usage-detail-table-wrap"><table className="usage-detail-table"><thead><tr><th>名称</th><th>请求次数</th><th>健康百分比</th><th>错误</th><th>平均耗时</th><th>请求占比</th></tr></thead><tbody>{rows.map((row) => {
    const health = row.requests === 0 ? null : (row.requests - row.errors) / row.requests;
    const share = totalRequests === 0 ? null : row.requests / totalRequests;
    return <tr key={row.name}><td data-label="名称"><strong title={row.name}>{row.name}</strong></td><td data-label="请求次数" className="usage-number">{row.requests.toLocaleString("zh-CN")}</td><td data-label="健康百分比" className={health === null ? "subtle" : health >= 0.95 ? "success-text" : health >= 0.8 ? "warning-text" : "danger-text"}>{health === null ? "—" : formatPercent(health, 1)}</td><td data-label="错误" className={row.errors ? "danger-text" : "subtle"}>{row.errors.toLocaleString("zh-CN")}</td><td data-label="平均耗时">{formatDuration(row.latencyMs)}</td><td data-label="请求占比" className="subtle">{share === null ? "—" : formatPercent(share, 1)}</td></tr>;
  })}</tbody></table></div>;
}

function getUsagePeriodLabel(window: Usage["window"]) {
  return window === "1h" ? "近 1 小时" : window === "24h" ? "近 24 小时" : "近 7 天";
}

type RequestFilters = { window: Usage["window"]; limit: number; offset: number; client: string; channel: string; model: string; sourceIp: string };

function RequestsView({ page, filters, refreshInterval, onRefreshIntervalChange, onFilterChange, onRefresh, onPageChange }: { page: RequestLogPage | undefined; filters: RequestFilters; refreshInterval: number | false; onRefreshIntervalChange: (interval: number | false) => void; onFilterChange: (filters: RequestFilters) => void; onRefresh: () => void; onPageChange: (offset: number) => void }) {
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + items.length, total);
  const canPrevious = filters.offset > 0;
  const canNext = Boolean(page?.hasMore);

  function update<K extends keyof RequestFilters>(key: K, value: RequestFilters[K]) {
    onFilterChange({ ...filters, [key]: value, offset: 0 });
  }

  const options = page?.filterOptions ?? { clients: [], channels: [], models: [], sourceIps: [] };
  const selectOptions = (values: string[], allLabel: string) => <><option value="">{allLabel}</option>{values.map((value) => <option value={value} key={value}>{value}</option>)}</>;

  return (
    <div className="view-stack requests-view">
      <section className="surface requests-surface">
        <form className="requests-filters">
          <label>时间范围<select aria-label="时间范围" value={filters.window} onChange={(event) => update("window", event.target.value as Usage["window"])}><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option></select></label>
          <label>每页条数<select aria-label="每页条数" value={filters.limit} onChange={(event) => update("limit", Number(event.target.value))}><option value={20}>20 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></label>
          <label>客户端<select aria-label="客户端" value={filters.client} onChange={(event) => update("client", event.target.value)}>{selectOptions(options.clients, "全部客户端")}</select></label>
          <label>渠道<select aria-label="渠道" value={filters.channel} onChange={(event) => update("channel", event.target.value)}>{selectOptions(options.channels, "全部渠道")}</select></label>
          <label>模型<select aria-label="模型" value={filters.model} onChange={(event) => update("model", event.target.value)}>{selectOptions(options.models, "全部模型")}</select></label>
          <label>来源 IP<select aria-label="来源 IP" value={filters.sourceIp} onChange={(event) => update("sourceIp", event.target.value)}>{selectOptions(options.sourceIps, "全部来源 IP")}</select></label>
          <span className="request-range">{total ? `${from}-${to} / 共 ${total} 条` : "暂无请求记录"}</span>
          <div className="request-auto-refresh">
            <label className="request-refresh-control">自动刷新
              <select aria-label="调用请求自动刷新间隔" value={refreshInterval === false ? "off" : String(refreshInterval / 1000)} onChange={(event) => onRefreshIntervalChange(event.target.value === "off" ? false : Number(event.target.value) * 1000)}>
                <option value="off">关闭</option>
                <option value="5">5 秒</option>
                <option value="10">10 秒</option>
                <option value="20">20 秒</option>
                <option value="30">30 秒</option>
              </select>
            </label>
            <button className="icon-button" type="button" title="刷新请求" aria-label="刷新请求" onClick={onRefresh}><RefreshCw size={16} /></button>
          </div>
        </form>
        <RequestTable items={items} />
        <footer className="request-pagination">
          <span>{page?.hasMore ? "还有更多请求" : total ? "已到列表末尾" : "调整筛选条件后重试"}</span>
          <div><button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={!canPrevious} onClick={() => onPageChange(Math.max(0, filters.offset - filters.limit))}><ChevronLeft size={16} /></button><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={!canNext} onClick={() => onPageChange(filters.offset + filters.limit)}><ChevronRight size={16} /></button></div>
        </footer>
      </section>
    </div>
  );
}

function RequestTable({ items }: { items: RequestLogEntry[] }) {
  if (items.length === 0) return <div className="request-empty"><Search size={22} /><strong>暂无请求</strong><span>请求经过网关后会出现在这里。</span></div>;
  return (
    <div className="request-table-scroll">
      <table className="request-table">
        <thead><tr><th>时间</th><th>客户端</th><th>来源 IP</th><th>渠道</th><th>密钥</th><th>流式</th><th>请求模型</th><th>推理强度</th><th>端点</th><th>输入</th><th>输出</th><th>缓存</th><th>耗时</th><th>首字节</th></tr></thead>
        <tbody>{items.map((item) => <RequestRow item={item} key={item.id} />)}</tbody>
      </table>
    </div>
  );
}

function RequestRow({ item }: { item: RequestLogEntry }) {
  const success = item.statusCode < 400;
  const date = new Date(item.createdAt);
  const clientLabel = item.clientName === "unknown" ? "未知客户端" : item.clientName;
  const channelLabel = item.channelName ?? item.providerName ?? "未路由";
  return <tr className={success ? "" : "request-row-error"}>
    <td data-label="时间" className="request-time">{formatRequestTime(date)}</td>
    <td data-label="客户端"><span className={`request-client request-client-${clientLabel.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`} title={clientLabel}>{clientLabel}</span></td>
    <td data-label="来源 IP" title={item.sourceIp ?? "—"}><span className="request-source-ip">{item.sourceIp ?? "—"}</span></td>
    <td data-label="渠道" title={channelLabel}>
      <span className="request-channel-with-icon">
        <ChannelSiteIcon channelId={item.channelId} channelName={channelLabel} className="request-channel-icon" />
        <span className="request-channel">{channelLabel}</span>
      </span>
    </td>
    <td data-label="密钥" title={item.gatewayKeyName ?? item.keyName ?? "未记录"}><span className="request-key-name">{item.gatewayKeyName ?? item.keyName ?? "未记录"}</span></td>
    <td data-label="流式"><span className={item.streamed ? "request-pill stream" : "request-pill non-stream"}>{item.streamed ? "流式" : "非流式"}</span></td>
    <td data-label="请求模型" title={item.modelAlias}><strong className="request-model-name">{item.modelAlias}</strong></td>
    <td data-label="推理强度"><span className={`request-reasoning${item.reasoningEffort ? " configured" : ""}`} title={item.reasoningEffort ?? ""}>{formatReasoningEffort(item.reasoningEffort)}</span></td>
    <td data-label="端点" title={item.endpoint}><code className="request-endpoint">{item.endpoint}</code></td>
    <td data-label="输入" className="request-number">{formatTokens(item.promptTokens)}</td>
    <td data-label="输出" className="request-number">{formatTokens(item.completionTokens)}</td>
    <td data-label="缓存" className="request-number request-cache">{item.cachedTokens === null ? "—" : formatTokens(item.cachedTokens)}</td>
    <td data-label="耗时"><span className={success ? "request-metric good" : "request-metric bad"}>{formatDuration(item.latencyMs)}</span></td>
    <td data-label="首字节"><span className="request-metric good">{item.firstByteLatencyMs === null ? "—" : formatDuration(item.firstByteLatencyMs)}</span></td>
  </tr>;
}

function formatReasoningEffort(value: string | null | undefined) {
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  };
  if (!value) return "—";
  return labels[value.toLowerCase()] ?? value;
}

function UsageBreakdown({ title, rows }: { title: string; rows: Usage["byModel"] }) {
  return <section className="surface breakdown"><SectionHead title={title} meta={`${rows.length} 项`} />{rows.map((row) => <div className="breakdown-row" key={row.name}><div><strong>{row.name}</strong><span>平均 {row.latencyMs} ms</span></div><span>{row.requests} 次</span><span className={row.errors ? "danger-text" : "subtle"}>{row.errors} 错误</span></div>)}</section>;
}

function SectionHead({ title, meta, action }: { title: string; meta: string; action?: React.ReactNode }) {
  return <header className="section-head"><div><h2>{title}</h2><span>{meta}</span></div>{action}</header>;
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      const result = await api.login({ username, password });
      onAuthenticated(result.username);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  return <div className="login-layer"><form className="login-panel login-page-panel" onSubmit={submit}>
    <span className="login-icon"><KeyRound size={20} /></span>
    <div><h2>登录 autoAPI</h2><p>使用管理员账号进入控制台。</p></div>
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    <label className="field"><span>用户名</span><input name="username" autoComplete="username" autoFocus required placeholder="管理员用户名" /></label>
    <label className="field"><span>密码</span><input name="password" type="password" autoComplete="current-password" required placeholder="管理员密码" /></label>
    <button className="button primary" disabled={pending}>{pending ? "登录中…" : "登录后台"}</button>
  </form></div>;
}

function SecurityView({ username, onLogout }: { username: string; onLogout: () => void }) {
  const history = useQuery({ queryKey: ["admin-login-history"], queryFn: api.loginHistory });
  const changePassword = useMutation({ mutationFn: api.changePassword });
  const [message, setMessage] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setMessage("两次输入的新密码不一致。");
      return;
    }
    const formElement = event.currentTarget;
    setMessage(null);
    changePassword.mutate({ currentPassword, newPassword }, {
      onSuccess: () => {
        formElement.reset();
        setMessage("密码已修改，下次登录请使用新密码。");
      },
      onError: (error) => setMessage(error instanceof Error ? error.message : "密码修改失败。"),
    });
  }

  return <div className="view-stack security-view">
    <section className="security-summary">
      <div><span>当前账号</span><strong>{username}</strong></div>
      <div><span>会话状态</span><strong className="security-online">已登录</strong></div>
      <button className="button secondary" onClick={onLogout}><LogOut size={15} /> 退出登录</button>
    </section>
    <div className="security-grid">
      <section className="surface security-panel">
        <SectionHead title="修改密码" meta="修改后立即生效" />
        <form className="security-form" onSubmit={submit}>
          <label className="field"><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label className="field"><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={8} required /><small>至少 8 个字符。</small></label>
          <label className="field"><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label>
          {message ? <div className="form-notice" role="status">{message}</div> : null}
          <button className="button primary" disabled={changePassword.isPending}>{changePassword.isPending ? "保存中…" : "保存新密码"}</button>
        </form>
      </section>
      <section className="surface security-panel login-history-panel">
        <SectionHead title="登录历史" meta="最近 10 条，包含登录 IP" />
        {history.isLoading ? <div className="security-empty">正在加载登录记录…</div> : history.error ? <div className="security-empty danger-text">登录记录加载失败。</div> : history.data?.length ? <div className="login-history-list">{history.data.map((record) => <LoginHistoryRow record={record} key={record.id} />)}</div> : <div className="security-empty">暂无登录记录。</div>}
      </section>
    </div>
  </div>;
}

function LoginHistoryRow({ record }: { record: AdminLoginRecord }) {
  return <div className="login-history-row">
    <span className={`login-result ${record.success ? "success" : "failed"}`}>{record.success ? "成功" : "失败"}</span>
    <div><strong>{record.ip}</strong><span>{record.username} · {formatDateTime(record.createdAt)}</span></div>
    <span className="login-user-agent" title={record.userAgent}>{record.userAgent}</span>
  </div>;
}

function LoadingState() {
  return <div className="loading-layout"><div className="skeleton metric-placeholder" /><div className="skeleton chart-placeholder" /><div className="skeleton table-placeholder" /></div>;
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <div className="error-state"><Activity size={22} /><h2>控制面板暂时不可用</h2><p>{error instanceof Error ? error.message : "控制台加载失败。"}</p><button className="button secondary" onClick={onRetry}><RefreshCw size={15} /> 重试</button></div>;
}

function refreshAll(client: ReturnType<typeof useQueryClient>) {
  return Promise.all([client.invalidateQueries({ queryKey: ["status"] }), client.invalidateQueries({ queryKey: ["channels"] }), client.invalidateQueries({ queryKey: ["pools"] }), client.invalidateQueries({ queryKey: ["usage"] })]);
}

function pageTitle(view: View) {
  return { overview: "网关概览", channels: "渠道管理", pools: "模型路由", usage: "用量分析", requests: "调用请求", playground: "模型测试", checkin: "公益站签到", security: "安全设置" }[view];
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function formatRequestTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

function formatTokens(value: number) {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString("zh-CN");
}

function formatDuration(value: number) {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
}

function formatPercent(value: number, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits }).format(value);
}

function getPoolHealthMetrics(pool: Pool, window: HealthWindow) {
  const points = window === "1h" ? pool.health1h
    : window === "6h" ? pool.recentHealth
      : window === "12h" ? pool.health12h
        : window === "24h" ? pool.hourlyHealth
          : pool.health7d;
  const requests = points.reduce((sum, point) => sum + point.requests, 0);
  const successfulRequests = points.reduce((sum, point) => sum + point.successfulRequests, 0);
  return {
    points,
    requests,
    successfulRequests,
    successRate: requests === 0 ? null : successfulRequests / requests,
  };
}

function getHealthWindowConfig(window: HealthWindow) {
  return {
    "1h": { label: "近 1 小时", durationMinutes: 5, startLabel: "1 小时前", middleLabel: "30 分钟前" },
    "6h": { label: "近 6 小时", durationMinutes: 5, startLabel: "6 小时前", middleLabel: "3 小时前" },
    "12h": { label: "近 12 小时", durationMinutes: 60, startLabel: "12 小时前", middleLabel: "6 小时前" },
    "24h": { label: "近 24 小时", durationMinutes: 60, startLabel: "24 小时前", middleLabel: "12 小时前" },
    "7d": { label: "近 7 天", durationMinutes: 24 * 60, startLabel: "7 天前", middleLabel: "3 天前" },
  }[window];
}

function getPoolAvailability(pool: Pool, window: HealthWindow): { label: string; tone: HealthTone } {
  const metrics = getPoolHealthMetrics(pool, window);
  if (metrics.successRate === null) {
    return { label: "暂无数据", tone: "no-data" };
  }
  if (metrics.successRate >= 0.8) return { label: "正常", tone: "available" };
  return { label: "异常", tone: "abnormal" };
}

function formatHealthTooltip(point: Pool["hourlyHealth"][number]) {
  const time = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" }).format(new Date(point.bucket));
  const status = formatHealthStatus(point.status);
  const success = point.successRate === null ? "无请求" : `健康百分比 ${formatPercent(point.successRate, 1)}`;
  return `${time} · ${status} · 请求 ${point.requests} · 成功 ${point.successfulRequests} · ${success}`;
}

function formatHealthStatus(status: Pool["hourlyHealth"][number]["status"]) {
  return status === "available" ? "可用" : status === "degraded" ? "降级" : status === "abnormal" ? "异常" : "无请求";
}

function formatHealthRange(value: string, durationMinutes: number) {
  const start = new Date(value);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return `${formatRecentHealthTime(start)} ~ ${formatRecentHealthTime(end)}`;
}

function formatRecentHealthTime(value: Date) {
  const parts = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatHealthPointTooltip(point: Pool["recentHealth"][number], durationMinutes: number) {
  return `${formatHealthRange(point.bucket, durationMinutes)} · 总请求 ${point.requests} · 成功数 ${point.successfulRequests} · 健康百分比 ${point.successRate === null ? "—" : formatHealthPercent(point.successRate)}`;
}

function formatHealthPercent(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function sortPoolsForHealth(pools: Pool[], window: HealthWindow, sort: HealthSort, group: HealthGroup) {
  const rank = { available: 0, degraded: 1, abnormal: 2, "no-data": 3 } as const;
  return [...pools].sort((a, b) => {
    const aMetrics = getPoolHealthMetrics(a, window);
    const bMetrics = getPoolHealthMetrics(b, window);
    const aAvailability = getPoolAvailability(a, window);
    const bAvailability = getPoolAvailability(b, window);
    if (group === "status") {
      const rankDiff = rank[aAvailability.tone] - rank[bAvailability.tone];
      if (rankDiff !== 0) return rankDiff;
    }
    if (group === "requests") {
      const requestsDiff = bMetrics.requests - aMetrics.requests;
      if (requestsDiff !== 0) return requestsDiff;
    }
    if (sort === "available") {
      const rankDiff = rank[aAvailability.tone] - rank[bAvailability.tone];
      if (rankDiff !== 0) return rankDiff;
      const successDiff = (bMetrics.successRate ?? -1) - (aMetrics.successRate ?? -1);
      if (successDiff !== 0) return successDiff;
    } else {
      const requestsDiff = bMetrics.requests - aMetrics.requests;
      if (requestsDiff !== 0) return requestsDiff;
    }
    return a.alias.localeCompare(b.alias);
  });
}

function formatHour(value: string | undefined) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" }).format(new Date(value)) : "—";
}

function formatLatency(value: number | null | undefined) {
  if (value === null || value === undefined || value <= 0) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`;
  return `${value.toLocaleString("zh-CN")} ms`;
}

function formatKnownBalance(channels: Channel[]) {
  const knownBalances = channels
    .map((channel) => channel.balance)
    .filter((balance): balance is number => balance !== null && Number.isFinite(balance));
  if (knownBalances.length === 0) return "—";
  const total = knownBalances.reduce((sum, balance) => sum + balance, 0);
  return `$${total.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function translateReason(reason: string | null) {
  const labels: Record<string, string> = {
    balance_below_minimum: "余额低于最低阈值",
    balance_exhausted: "余额不足",
    rate_limited: "触发频率限制",
    upstream_5xx: "上游服务错误",
    connection_error: "连接失败",
    timeout: "上游请求超时",
  };
  return reason ? labels[reason] ?? reason : "健康检查失败";
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}
