import { Fragment, lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, ChevronDown, ChevronLeft, ChevronRight, CirclePlus, Clock3, Coins, Copy, GitBranch, Gauge, Github, KeyRound, LayoutGrid, LogOut, Moon, RefreshCw, Route, Search, ShieldAlert, Sun, Trash2, WalletCards, type LucideIcon } from "lucide-react";
import { ApiError, api, clearAdminSession, getAdminToken, hasAdminSession } from "./api";
import { ChannelTable } from "./components/ChannelTable";
import { ChangePasswordDialog } from "./components/ChangePasswordDialog";
import { ChannelEditor } from "./components/ChannelEditor";
import { HealthMeter } from "./components/HealthMeter";
import { MetricStrip } from "./components/MetricStrip";
import { ModelAliasDialog } from "./components/ModelAliasDialog";
import { Playground } from "./components/Playground";
import { ProviderDrawer } from "./components/ProviderDrawer";
import { ProbeResultDialog } from "./components/ProbeResultDialog";
import { GatewayKeyDialog } from "./components/GatewayKeyDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusDot } from "./components/StatusDot";
import type { AdminLoginRecord, Channel, GatewayLogEntry, GatewayStatus, LogPage, Pool, ProbeResponse, RequestLogEntry, RequestLogPage, SystemLogEntry, Usage, View } from "./types";
import { api as apiCheckin } from "./checkin/api";
import CheckinModule, { CheckinTabs, SettingsView, type CheckinView, type SettingsNotify } from "./checkin/CheckinModule";

const UsageChart = lazy(() => import("./components/UsageChart"));

type HealthWindow = "1h" | "6h" | "12h" | "24h" | "7d";
type HealthGroup = "default" | "status" | "requests";
type HealthScope = "all" | "available" | "abnormal" | "no-data";
type HealthSort = "available" | "requests";
type HealthTone = "available" | "degraded" | "abnormal" | "no-data";
type ColorTheme = "light" | "dark";
type BgStyle = "grid" | "plain" | "dots" | "gradient";

type DeletedChannelRecord = {
  id: string;
  name: string;
  status: Channel["status"];
  isolationReason: string | null;
  consecutiveFailures: number;
  deletedAt: string;
};

type RemoveChannelInput = {
  id: string;
  record: Omit<DeletedChannelRecord, "deletedAt">;
};

type OperationLogEntry = {
  id: string;
  createdAt: string;
  action: string;
  detail: string;
  status: "running" | "success" | "error" | "info";
};

const colorThemeStorageKey = "autoapi-color-theme";
const bgStyleStorageKey = "autoapi-bg-style";
const activeViewStorageKey = "autoapi-active-view";
const activeCheckinViewStorageKey = "autoapi-active-checkin-view";
const operationLogStorageKey = "autoapi-operation-log";

const appViews: View[] = ["overview", "channels", "requests", "playground", "checkin", "security"];
const checkinViews: CheckinView[] = ["dashboard", "history"];

function initialColorTheme(): ColorTheme {
  return localStorage.getItem(colorThemeStorageKey) === "dark" ? "dark" : "light";
}

const bgStyleOptions: { value: BgStyle; label: string }[] = [
  { value: "grid", label: "网格" },
  { value: "plain", label: "纯色" },
  { value: "dots", label: "点阵" },
  { value: "gradient", label: "渐变" },
];

function initialBgStyle(): BgStyle {
  const saved = localStorage.getItem(bgStyleStorageKey);
  return saved && bgStyleOptions.some((opt) => opt.value === saved) ? saved as BgStyle : "grid";
}

function initialView(): View {
  const saved = localStorage.getItem(activeViewStorageKey);
  return saved && appViews.includes(saved as View) ? saved as View : "overview";
}

function initialCheckinView(): CheckinView {
  const saved = localStorage.getItem(activeCheckinViewStorageKey);
  return saved && checkinViews.includes(saved as CheckinView) ? saved as CheckinView : "dashboard";
}

function initialOperationLog(): OperationLogEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(operationLogStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? (parsed as OperationLogEntry[]).slice(0, 10).filter((entry) => entry.status !== "running")
      : [];
  } catch {
    return [];
  }
}

type SyncBalanceResult = Awaited<ReturnType<typeof api.syncCheckinSiteBalance>>;

function formatBalanceSyncDetail(channels: Channel[] | undefined, result: SyncBalanceResult): string {
  if (result.skippedBecauseBalanceIsUnknown) return "站点暂无已知余额，未更新渠道";
  const updatedNames = result.updatedChannelIds.map(
    (id) => channels?.find((channel) => channel.id === id)?.name ?? `渠道 ${id.slice(0, 8)}`,
  );
  const balance = result.result?.balance;
  const balanceText = balance === null || balance === undefined
    ? ""
    : `${result.result?.currency === "USD" ? "$" : `${result.result?.currency ?? ""} `}${balance.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}`;
  return [
    `更新 ${updatedNames.length} 个渠道：${updatedNames.join("、")}`,
    balanceText ? `签到站余额 ${balanceText}` : "",
    result.result?.status ? `状态 ${result.result.status}` : "",
  ].filter(Boolean).join("；");
}

export default function App() {
  const queryClient = useQueryClient();
  const [authenticated, setAuthenticated] = useState(() => hasAdminSession());
  const [colorTheme, setColorTheme] = useState<ColorTheme>(initialColorTheme);
  const [bgStyle, setBgStyle] = useState<BgStyle>(initialBgStyle);
  const [bgStyleOpen, setBgStyleOpen] = useState(false);
  const bgStyleRef = useRef<HTMLDivElement>(null);
  const [adminUsername, setAdminUsername] = useState("管理员");
  const [view, setView] = useState<View>(initialView);
  const [checkinView, setCheckinView] = useState<CheckinView>(initialCheckinView);
  const [usageWindow, setUsageWindow] = useState<Usage["window"]>("24h");
  const [providerOpen, setProviderOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [gatewayKeysOpen, setGatewayKeysOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const [baseUrlCopied, setBaseUrlCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [deletedChannelRecords, setDeletedChannelRecords] = useState<DeletedChannelRecord[]>([]);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [requestFilters, setRequestFilters] = useState<RequestFilters>({ window: "24h", limit: 20, offset: 0, client: "", channel: "", model: "", sourceIp: "" });
  const [requestRefreshInterval, setRequestRefreshInterval] = useState<number | false>(5_000);
  const [logRefreshInterval, setLogRefreshInterval] = useState<number | false>(10_000);
  const [gatewayLogFilters, setGatewayLogFilters] = useState<GatewayLogFilters>({ limit: 50, offset: 0, model: "", channel: "", statusCode: "", errorType: "" });
  const [systemLogFilters, setSystemLogFilters] = useState<SystemLogFilters>({ limit: 50, offset: 0, level: "", source: "" });
  const [logRetentionDays, setLogRetentionDays] = useState<number | null>(null);
  const [operationLog, setOperationLog] = useState<OperationLogEntry[]>(initialOperationLog);

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, enabled: authenticated, refetchInterval: 30_000 });
  const latestVersion = useQuery({ queryKey: ["latestVersion"], queryFn: api.latestVersion, enabled: authenticated, refetchInterval: 5 * 60_000 });
  const currentVersion = status.data?.version ?? null;
  const remoteLatest = latestVersion.data?.latest ?? null;
  const versionOutdated = Boolean(currentVersion && remoteLatest && currentVersion !== remoteLatest);
  const versionTitle = versionOutdated
    ? `当前版本 ${currentVersion} 不是最新\n最新版本 ${remoteLatest}\n点击查看 GitHub 仓库`
    : "autoAPI GitHub 项目地址";
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
  const gatewayLogs = useQuery({
    queryKey: ["gatewayLogs", gatewayLogFilters],
    queryFn: () => api.gatewayLogs(gatewayLogFilters),
    enabled: authenticated && view === "requests",
    refetchInterval: logRefreshInterval,
    refetchIntervalInBackground: false,
  });
  const systemLogs = useQuery({
    queryKey: ["systemLogs", systemLogFilters],
    queryFn: () => api.systemLogs(systemLogFilters),
    enabled: authenticated && view === "requests",
    refetchInterval: logRefreshInterval,
    refetchIntervalInBackground: false,
  });
  const logSettings = useQuery({
    queryKey: ["logSettings"],
    queryFn: api.logSettings,
    enabled: authenticated && view === "requests",
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
      setActionNotice(formatBalanceSyncDetail(channels.data, result));
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
    mutationFn: ({ id }: RemoveChannelInput) => api.deleteChannel(id),
    onSuccess: async (_result, variables) => {
      setActionError(null);
      setActionNotice(`已删除渠道“${variables.record.name}”，记录已保留在隔离详情中`);
      setDeletedChannelRecords((current) => [
        { ...variables.record, deletedAt: new Date().toISOString() },
        ...current.filter((record) => record.id !== variables.id),
      ].slice(0, 10));
      await refreshAll(queryClient);
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "渠道删除失败，请重试。");
    },
  });
  const toggleChannel = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setChannelEnabled(id, enabled),
    onSuccess: (_result, variables) => {
      setActionError(null);
      setActionNotice(variables.enabled ? "渠道已设为可用，正在重新检测" : "渠道已禁用");
      void refreshAll(queryClient);
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "渠道状态更新失败，请重试。");
    },
  });
  const updateProtocol = useMutation({
    mutationFn: ({ channel, protocol }: { channel: Channel; protocol: string }) => api.updateChannel(channel.id, {
      name: channel.name,
      baseUrl: channel.baseUrl,
      faviconUrl: channel.faviconUrl,
      protocol,
      models: channel.models,
      priority: channel.priority,
      weight: channel.weight,
      minBalance: channel.minBalance,
      tags: channel.tags,
      enabled: channel.enabled,
    }),
    onSuccess: async (_result, variables) => {
      setActionError(null);
      setActionNotice(`已将 ${variables.channel.name} 的协议切换为 ${variables.protocol}`);
      await refreshAll(queryClient);
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "协议切换失败，请重试。");
    },
  });
  const reorderChannels = useMutation({
    mutationFn: (channelIds: string[]) => api.reorderChannels(channelIds),
    onSuccess: () => refreshAll(queryClient),
    onError: (error) => setActionError(error instanceof Error ? error.message : "渠道排序保存失败，请重试。"),
  });
  const updateLogRetention = useMutation({
    mutationFn: (retentionDays: number) => api.updateLogSettings(retentionDays),
    onSuccess: (result) => {
      setActionError(null);
      setLogRetentionDays(result.retentionDays);
      setActionNotice(`日志保留天数已设为 ${result.retentionDays} 天`);
      void queryClient.invalidateQueries({ queryKey: ["logSettings"] });
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "日志保留天数更新失败，请重试。");
    },
  });
  const clearAllLogs = useMutation({
    mutationFn: () => api.clearAllLogs(),
    onSuccess: (result) => {
      setActionError(null);
      setActionNotice(`已清空全部日志（删除 ${result.removed} 个文件）`);
      void gatewayLogs.refetch();
      void systemLogs.refetch();
    },
    onError: (error) => {
      setActionNotice(null);
      setActionError(error instanceof Error ? error.message : "清空日志失败，请重试。");
    },
  });

  const authError = [status.error, channels.error, pools.error, usage.error, ...(view === "requests" ? [requests.error, gatewayLogs.error, systemLogs.error].filter(Boolean) : [])].find(
    (error) => error instanceof ApiError && error.status === 401,
  );
  const loading = status.isLoading || channels.isLoading || pools.isLoading || usage.isLoading || (view === "requests" && (requests.isLoading || gatewayLogs.isLoading || systemLogs.isLoading));
  const failed = status.error ?? channels.error ?? pools.error ?? usage.error ?? (view === "requests" ? (requests.error ?? gatewayLogs.error ?? systemLogs.error) : null);
  const showLogin = !authenticated;

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    void api.me().then((result) => {
      if (active) setAdminUsername(result.username);
    }).catch((error: unknown) => {
      if (active && error instanceof ApiError && error.status === 401) {
        clearAdminSession();
        setDeletedChannelRecords([]);
        setAuthenticated(false);
      }
    });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !authError) return;
    clearAdminSession();
    queryClient.clear();
    setDeletedChannelRecords([]);
    setAuthenticated(false);
    setAdminUsername("管理员");
  }, [authenticated, authError, queryClient]);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    localStorage.setItem(colorThemeStorageKey, colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    document.documentElement.dataset.bgStyle = colorTheme === "light" ? bgStyle : "dark";
    localStorage.setItem(bgStyleStorageKey, bgStyle);
  }, [bgStyle, colorTheme]);

  useEffect(() => {
    if (!bgStyleOpen) return;
    const handler = (event: MouseEvent) => {
      if (bgStyleRef.current && !bgStyleRef.current.contains(event.target as Node)) setBgStyleOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [bgStyleOpen]);

  useEffect(() => {
    localStorage.setItem(activeViewStorageKey, view);
  }, [view]);

  useEffect(() => {
    localStorage.setItem(activeCheckinViewStorageKey, checkinView);
  }, [checkinView]);

  useEffect(() => {
    localStorage.setItem(operationLogStorageKey, JSON.stringify(operationLog));
  }, [operationLog]);

  useEffect(() => {
    if (!userMenuOpen) return;
    function handleOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [userMenuOpen]);

  if (showLogin) return <LoginPage onAuthenticated={authenticatedSuccessfully} />;

  function createOperationLogId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
      const time = Date.now();
      bytes[0] = (time >>> 24) & 0xff;
      bytes[1] = (time >>> 16) & 0xff;
      bytes[2] = (time >>> 8) & 0xff;
      bytes[3] = time & 0xff;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function appendOperationLog(action: string, detail: string, status: OperationLogEntry['status'] = 'info', id?: string) {
    const entryId = id ?? createOperationLogId();
    setOperationLog((current) => {
      if (id) {
        return current.map((entry) => entry.id === id ? { ...entry, detail, status } : entry).slice(0, 10);
      }
      return [
        { id: entryId, createdAt: new Date().toISOString(), action, detail, status },
        ...current,
      ].slice(0, 10);
    });
    return entryId;
  }

  function refreshed() {
    void refreshAll(queryClient);
  }

  function authenticatedSuccessfully(username: string) {
    setDeletedChannelRecords([]);
    setAdminUsername(username);
    setAuthenticated(true);
    void queryClient.resetQueries();
  }

  function logout() {
    clearAdminSession();
    setDeletedChannelRecords([]);
    setAuthenticated(false);
    setAdminUsername("管理员");
    queryClient.clear();
  }

  function requestDelete(channel: Channel) {
    if (!window.confirm(`确定删除渠道“${channel.name}”吗？该渠道的模型路由也会被删除。`)) return;
    setActionError(null);
    const logId = appendOperationLog("删除渠道", `删除 ${channel.name}`, "running");
    void removeChannel.mutateAsync({
      id: channel.id,
      record: {
        id: channel.id,
        name: channel.name,
        status: channel.status,
        isolationReason: channel.isolationReason,
        consecutiveFailures: channel.consecutiveFailures,
      },
    })
      .then(() => appendOperationLog("删除渠道", `已删除 ${channel.name}`, "success", logId))
      .catch((error: unknown) => appendOperationLog("删除渠道", error instanceof Error ? error.message : "删除失败", "error", logId));
  }

  function toggle(channel: Channel, enabled = !channel.enabled) {
    setActionError(null);
    const logId = appendOperationLog("启用状态", `${enabled ? "启用" : "停用"} ${channel.name}`, "running");
    void toggleChannel.mutateAsync({ id: channel.id, enabled })
      .then(() => appendOperationLog("启用状态", `${enabled ? "已启用" : "已停用"} ${channel.name}`, "success", logId))
      .catch((error: unknown) => appendOperationLog("启用状态", error instanceof Error ? error.message : "状态更新失败", "error", logId));
  }

  function requestProbe(channelId: string) {
    const channel = channels.data?.find((item) => item.id === channelId);
    const label = channel ? channel.name : channelId;
    setActionError(null);
    const logId = appendOperationLog("渠道探测", `开始探测 ${label}`, "running");
    void probe.mutateAsync(channelId)
      .then((result) => appendOperationLog("渠道探测", `探测成功 ${label}：${result.probe.probedModel ?? "无模型"}`, "success", logId))
      .catch((error: unknown) => appendOperationLog("渠道探测", error instanceof Error ? error.message : "探测失败", "error", logId));
  }

  function changeProtocol(channel: Channel, protocol: string) {
    const logId = appendOperationLog("协议切换", `${channel.name} -> ${protocol}`, "running");
    void updateProtocol.mutateAsync({ channel, protocol })
      .then(() => appendOperationLog("协议切换", `${channel.name} 已切换为 ${protocol}`, "success", logId))
      .catch((error: unknown) => appendOperationLog("协议切换", error instanceof Error ? error.message : "切换失败", "error", logId));
  }

  function handleSyncBalance(siteId: number) {
    const channel = channels.data?.find((item) => item.checkinSite?.id === siteId);
    const logId = appendOperationLog("余额同步", channel ? `同步 ${channel.name}` : `同步站点 ${siteId}`, "running");
    void syncBalance.mutateAsync(siteId)
      .then((result) => appendOperationLog("余额同步", formatBalanceSyncDetail(channels.data, result), "success", logId))
      .catch((error: unknown) => appendOperationLog("余额同步", error instanceof Error ? error.message : "同步失败", "error", logId));
  }

  function handleRefreshBalances() {
    const logId = appendOperationLog("余额刷新", "开始批量刷新余额", "running");
    void refreshBalances.mutateAsync()
      .then((result) => appendOperationLog("余额刷新", `成功 ${result.summary.refreshed}，未知 ${result.summary.unknown}，失败 ${result.summary.failed}`, "success", logId))
      .catch((error: unknown) => appendOperationLog("余额刷新", error instanceof Error ? error.message : "刷新失败", "error", logId));
  }

  function handleReorder(channelIds: string[]) {
    const logId = appendOperationLog("渠道排序", "保存新排序", "running");
    return reorderChannels.mutateAsync(channelIds)
      .then(() => {
        appendOperationLog("渠道排序", "排序已保存", "success", logId);
      })
      .catch((error: unknown) => {
        appendOperationLog("渠道排序", error instanceof Error ? error.message : "保存失败", "error", logId);
        throw error;
      });
  }

  const effectiveGatewayBaseUrl = status.data?.publicBaseUrl
    ? `${status.data.publicBaseUrl.replace(/\/+$/, "")}/v1`
    : typeof window !== "undefined" && window.location?.origin
      ? `${window.location.origin.replace(/\/+$/, "")}/v1`
      : (status.data?.gatewayBaseUrl ?? "");

  async function copyBaseUrl() {
    const value = effectiveGatewayBaseUrl || status.data?.gatewayBaseUrl;
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
      <Sidebar view={view} onChange={setView} version={status.data?.version ?? "加载中…"} versionOutdated={versionOutdated} latestVersion={remoteLatest} />
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
              <code className="mono">{effectiveGatewayBaseUrl || (status.isLoading ? "加载中…" : "加载中…")}</code>
              <button className="icon-button" title={baseUrlCopied ? "已复制" : "复制 Base URL"} aria-label={baseUrlCopied ? "已复制" : "复制 Base URL"} onClick={() => void copyBaseUrl()} disabled={!effectiveGatewayBaseUrl}>{baseUrlCopied ? <Check size={15} /> : <Copy size={15} />}</button>
            </div>
            <button className="icon-button theme-toggle" title={colorTheme === "light" ? "切换至深色模式" : "切换至浅色模式"} aria-label={colorTheme === "light" ? "切换至深色模式" : "切换至浅色模式"} onClick={() => setColorTheme((theme) => theme === "light" ? "dark" : "light")}>{colorTheme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button>
            {colorTheme === "light" ? (
              <div className="bg-style-picker" ref={bgStyleRef}>
                <button className="icon-button" title="背景风格" aria-label="背景风格" onClick={() => setBgStyleOpen((open) => !open)}><LayoutGrid size={16} /></button>
                {bgStyleOpen ? (
                  <div className="bg-style-panel" role="menu">
                    {bgStyleOptions.map((opt) => (
                      <button key={opt.value} role="menuitemradio" aria-checked={bgStyle === opt.value} className={bgStyle === opt.value ? "active" : ""} onClick={() => { setBgStyle(opt.value); setBgStyleOpen(false); }}>
                        <span className={`bg-style-preview bg-style-${opt.value}`} />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <button className="button secondary key-button" onClick={() => setGatewayKeysOpen(true)}><KeyRound size={15} /> 访问密钥</button>
            <div className="user-menu" ref={userMenuRef} onMouseEnter={() => setUserMenuOpen(true)} onMouseLeave={() => setUserMenuOpen(false)}>
              <button className="button secondary security-button" onClick={() => setUserMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={userMenuOpen}><ShieldAlert size={15} /> {adminUsername} <ChevronDown size={12} className={userMenuOpen ? "user-menu-chevron open" : "user-menu-chevron"} /></button>
              {userMenuOpen ? (
                <div className="user-menu-panel" role="menu">
                  <button role="menuitem" onClick={() => { setUserMenuOpen(false); setChangePasswordOpen(true); }}><KeyRound size={14} /> 修改密码</button>
                  <button role="menuitem" onClick={() => { setUserMenuOpen(false); logout(); }}><LogOut size={14} /> 退出登录</button>
                </div>
              ) : null}
            </div>
            <a className={"github-version-link" + (versionOutdated ? " version-outdated" : "")} href="https://github.com/fu5502/autoAPI" target="_blank" rel="noreferrer" aria-label="autoAPI GitHub 项目地址" title={versionTitle}><Github size={14} /><span className="runtime-version">{status.data?.version ?? "加载中…"}</span></a>
          </div>
        </header>
        {actionError ? <div className="action-error" role="alert">{actionError}</div> : null}
        {actionNotice ? <div className="action-notice" role="status">{actionNotice}</div> : null}

        {view === "checkin" ? <CheckinModule view={checkinView} /> : null}
        {view !== "checkin" && loading ? <LoadingState /> : null}
        {view !== "checkin" && failed && !authError ? <ErrorState error={failed} onRetry={refreshed} /> : null}
        {view !== "checkin" && !loading && !failed && status.data && channels.data && pools.data && usage.data ? (
          <>
            {view === "overview" ? <OverviewUsageView status={status.data} pools={pools.data} usage={usage.data} usageWindow={usageWindow} onUsageWindowChange={setUsageWindow} syncingBalanceId={syncBalance.isPending ? syncBalance.variables ?? null : null} balanceRefreshPending={refreshBalances.isPending} onSyncBalance={handleSyncBalance} probingId={probe.variables ?? null} onProbe={requestProbe} onEdit={setEditingChannel} onDelete={requestDelete} onToggle={toggle} onProtocolChange={changeProtocol} protocolChangingId={updateProtocol.isPending ? updateProtocol.variables?.channel.id ?? null : null} togglingId={toggleChannel.variables?.id ?? null} deletingId={removeChannel.isPending ? removeChannel.variables?.id ?? null : null} onReorder={handleReorder} /> : null}
            {view === "channels" ? <ChannelsPoolsView channels={channels.data} pools={pools.data} deletedChannelRecords={deletedChannelRecords} syncingBalanceId={syncBalance.isPending ? syncBalance.variables ?? null : null} balanceRefreshPending={refreshBalances.isPending} onSyncBalance={handleSyncBalance} onRefreshBalances={handleRefreshBalances} probingId={probe.variables ?? null} onProbe={requestProbe} onEdit={setEditingChannel} onDelete={requestDelete} onToggle={toggle} onProtocolChange={changeProtocol} protocolChangingId={updateProtocol.isPending ? updateProtocol.variables?.channel.id ?? null : null} togglingId={toggleChannel.variables?.id ?? null} deletingId={removeChannel.isPending ? removeChannel.variables?.id ?? null : null} onReorder={handleReorder} onAddChannel={() => { appendOperationLog("渠道配置", "打开添加渠道", "info"); setProviderOpen(true); }} onAddRoute={() => { appendOperationLog("路由配置", "打开模型路由配置", "info"); setAliasOpen(true); }} operations={operationLog} /> : null}
            {view === "requests" ? <RequestsLogsView page={requests.data} channels={channels.data ?? []} filters={requestFilters} refreshInterval={requestRefreshInterval} onRefreshIntervalChange={setRequestRefreshInterval} onFilterChange={(next) => setRequestFilters({ ...next, offset: 0 })} onPageChange={(offset) => setRequestFilters((current) => ({ ...current, offset }))} gatewayPage={gatewayLogs.data} systemPage={systemLogs.data} gatewayFilters={gatewayLogFilters} systemFilters={systemLogFilters} logRefreshInterval={logRefreshInterval} onLogRefreshIntervalChange={setLogRefreshInterval} retentionDays={logSettings.data?.retentionDays ?? null} savingRetention={updateLogRetention.isPending} onRetentionChange={(days) => updateLogRetention.mutate(days)} clearing={clearAllLogs.isPending} onClearAll={() => clearAllLogs.mutate()} onGatewayFilterChange={(next) => setGatewayLogFilters({ ...next, offset: 0 })} onSystemFilterChange={(next) => setSystemLogFilters({ ...next, offset: 0 })} onGatewayPageChange={(offset) => setGatewayLogFilters((current) => ({ ...current, offset }))} onSystemPageChange={(offset) => setSystemLogFilters((current) => ({ ...current, offset }))} /> : null}
            {view === "playground" ? <Playground channels={channels.data} onUpdated={refreshed} /> : null}
            {view === "security" ? <SecurityView /> : null}
          </>
        ) : null}
      </main>
      <ProviderDrawer open={providerOpen} onClose={() => setProviderOpen(false)} onCreated={() => { appendOperationLog("渠道配置", "渠道已添加", "success"); refreshed(); }} />
      <GatewayKeyDialog open={gatewayKeysOpen} onClose={() => setGatewayKeysOpen(false)} />
      <ChangePasswordDialog open={changePasswordOpen} username={adminUsername} onClose={() => setChangePasswordOpen(false)} />
      <ChannelEditor channel={editingChannel} onClose={() => setEditingChannel(null)} onSaved={() => { appendOperationLog("渠道配置", editingChannel ? `已保存 ${editingChannel.name}` : "渠道已保存", "success"); refreshed(); }} />
      <ProbeResultDialog result={probeResult} onClose={() => setProbeResult(null)} />
      <ModelAliasDialog open={aliasOpen} channels={channels.data ?? []} onClose={() => setAliasOpen(false)} onCreated={() => { appendOperationLog("路由配置", "模型路由已保存", "success"); refreshed(); }} />
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

function OverviewUsageView({ status, pools, usage, usageWindow, onUsageWindowChange, syncingBalanceId, balanceRefreshPending, onSyncBalance, probingId, onProbe, onEdit, onDelete, onToggle, onProtocolChange, protocolChangingId, togglingId, deletingId, onReorder }: {
  status: NonNullable<ReturnType<typeof api.status> extends Promise<infer T> ? T : never>;
  pools: Pool[];
  usage: Usage;
  usageWindow: Usage["window"];
  onUsageWindowChange: (window: Usage["window"]) => void;
  syncingBalanceId: number | null;
  balanceRefreshPending: boolean;
  onSyncBalance: (siteId: number) => void;
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel, enabled?: boolean) => void;
  onProtocolChange: (channel: Channel, protocol: string) => void;
  protocolChangingId: string | null;
  togglingId: string | null;
  deletingId: string | null;
  onReorder: (channelIds: string[]) => Promise<void>;
}) {
  const [tab, setTab] = useState<"overview" | "usage">("overview");
  return (
    <>
      <div className="logs-tabs">
        <button className={tab === "overview" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("overview")}>概览</button>
        <button className={tab === "usage" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("usage")}>用量</button>
      </div>
      {tab === "overview"
        ? <Overview status={status} pools={pools} syncingBalanceId={syncingBalanceId} balanceRefreshPending={balanceRefreshPending} onSyncBalance={onSyncBalance} probingId={probingId} onProbe={onProbe} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onProtocolChange={onProtocolChange} protocolChangingId={protocolChangingId} togglingId={togglingId} deletingId={deletingId} onReorder={onReorder} />
        : <UsageView usage={usage} window={usageWindow} onWindowChange={onUsageWindowChange} />}
    </>
  );
}

function Overview({
  status,
  pools,
  syncingBalanceId,
  balanceRefreshPending,
  onSyncBalance,
  probingId,
  onProbe,
  onEdit,
  onDelete,
  onToggle,
  onProtocolChange,
  protocolChangingId,
  togglingId,
  deletingId,
  onReorder,
}: {
  status: NonNullable<ReturnType<typeof api.status> extends Promise<infer T> ? T : never>;
  pools: Pool[];
  syncingBalanceId: number | null;
  balanceRefreshPending: boolean;
  onSyncBalance: (siteId: number) => void;
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel, enabled?: boolean) => void;
  onProtocolChange: (channel: Channel, protocol: string) => void;
  protocolChangingId: string | null;
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
    </div>
  );
}

function PoolHealthCard({ pool, window }: { pool: Pool; window: HealthWindow }) {
  const availability = getPoolAvailability(pool, window);
  const metrics = getPoolHealthMetrics(pool, window);
  const config = getHealthWindowConfig(window);
  return (
    <article className="pool-health-card">
      <div className="pool-health-head">
        <div className="pool-health-title">
          <strong className="mono">{pool.alias}</strong>
          <span className={`pool-health-status status-${availability.tone}`}>{availability.label}</span>
        </div>
        <div className="pool-health-summary">
          <strong className={`pool-health-percent tone-${availability.tone}`}>{metrics.successRate === null ? "暂无请求" : formatPercent(metrics.successRate, 1)}</strong>
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

function ChannelsPoolsView({ channels, pools, deletedChannelRecords, syncingBalanceId, balanceRefreshPending, onSyncBalance, onRefreshBalances, probingId, onProbe, onEdit, onDelete, onToggle, onProtocolChange, protocolChangingId, togglingId, deletingId, onReorder, onAddChannel, onAddRoute, operations }: {
  channels: Channel[];
  pools: Pool[];
  deletedChannelRecords: DeletedChannelRecord[];
  syncingBalanceId: number | null;
  balanceRefreshPending: boolean;
  onSyncBalance: (siteId: number) => void;
  onRefreshBalances: () => void;
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel, enabled?: boolean) => void;
  onProtocolChange: (channel: Channel, protocol: string) => void;
  protocolChangingId: string | null;
  togglingId: string | null;
  deletingId: string | null;
  onReorder: (channelIds: string[]) => Promise<void>;
  onAddChannel: () => void;
  onAddRoute: () => void;
  operations: OperationLogEntry[];
}) {
  const [tab, setTab] = useState<"channels" | "pools">("channels");
  return (
    <>
      <div className="logs-tabs">
        <button className={tab === "channels" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("channels")}>渠道</button>
        <button className={tab === "pools" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("pools")}>模型池</button>
      </div>
      {tab === "channels"
        ? <ChannelsView channels={channels} deletedChannelRecords={deletedChannelRecords} syncingBalanceId={syncingBalanceId} balanceRefreshPending={balanceRefreshPending} onSyncBalance={onSyncBalance} onRefreshBalances={onRefreshBalances} probingId={probingId} onProbe={onProbe} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onProtocolChange={onProtocolChange} protocolChangingId={protocolChangingId} togglingId={togglingId} deletingId={deletingId} onReorder={onReorder} onAddChannel={onAddChannel} operations={operations} />
        : <PoolsView pools={pools} channels={channels} onAddRoute={onAddRoute} operations={operations} />}
    </>
  );
}

function ChannelsView({ channels, deletedChannelRecords, syncingBalanceId, balanceRefreshPending, onSyncBalance, onRefreshBalances, probingId, onProbe, onEdit, onDelete, onToggle, onProtocolChange, protocolChangingId, togglingId, deletingId, onReorder, onAddChannel, operations }: { channels: Channel[]; deletedChannelRecords: DeletedChannelRecord[]; syncingBalanceId: number | null; balanceRefreshPending: boolean; onSyncBalance: (siteId: number) => void; onRefreshBalances: () => void; probingId: string | null; onProbe: (id: string) => void; onEdit: (channel: Channel) => void; onDelete: (channel: Channel) => void; onToggle: (channel: Channel, enabled?: boolean) => void; onProtocolChange: (channel: Channel, protocol: string) => void; protocolChangingId: string | null; togglingId: string | null; deletingId: string | null; onReorder: (channelIds: string[]) => Promise<void>; onAddChannel: () => void; operations: OperationLogEntry[] }) {
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
        <ChannelTable channels={channels} syncingBalanceId={syncingBalanceId} balanceRefreshPending={balanceRefreshPending} onSyncBalance={onSyncBalance} probingId={probingId} onProbe={onProbe} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onProtocolChange={onProtocolChange} protocolChangingId={protocolChangingId} togglingId={togglingId} deletingId={deletingId} onReorder={onReorder} />
      </section>
      <OperationLogSection items={operations} />
      <section className="surface detail-list">
        <SectionHead title="隔离详情" meta={deletedChannelRecords.length > 0 ? `自动熔断状态 · 已删除 ${deletedChannelRecords.length} 条` : "自动熔断状态"} />
        {channels.filter((channel) => channel.status === "isolated" || channel.status === "degraded").map((channel) => (
          <div className="detail-row" key={channel.id}>
            <ShieldAlert size={17} />
            <div><strong>{channel.name}</strong><span>{translateReason(channel.isolationReason)}</span></div>
            <span>连续失败 {channel.consecutiveFailures} 次</span>
          </div>
        ))}
        {deletedChannelRecords.map((record) => (
          <div className="detail-row detail-row-deleted" key={`${record.id}-${record.deletedAt}`}>
            <Trash2 size={17} />
            <div><strong>{record.name}</strong><span>已删除 · 删除前{formatChannelStatus(record.status)} · {record.isolationReason ? translateReason(record.isolationReason) : "无隔离原因"}</span></div>
            <time dateTime={record.deletedAt}>{formatDateTime(record.deletedAt)}</time>
          </div>
        ))}
        {channels.every((channel) => channel.status !== "isolated" && channel.status !== "degraded") && deletedChannelRecords.length === 0 ? <div className="detail-empty">暂无隔离或删除记录</div> : null}
      </section>
    </div>
  );
}

function PoolsView({ pools, channels, onAddRoute, operations }: { pools: Pool[]; channels: Channel[]; onAddRoute: () => void; operations: OperationLogEntry[] }) {
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
                    <td>
                      <HealthMeter
                        percent={pool.totalRequests1h === 0 ? null : (1 - pool.errorRate1h) * 100}
                        tone={pool.totalRequests1h === 0 ? "none" : pool.errorRate1h > 0.2 ? "bad" : pool.errorRate1h > 0.05 ? "warn" : "good"}
                        value={pool.totalRequests1h === 0 ? "—" : formatPercent(1 - pool.errorRate1h)}
                        label={`${pool.alias} 最近 1 小时健康百分比`}
                      />
                    </td>
                    <td>{pool.averageLatencyMs1h} ms</td>
                    <td>
                      <div className="pool-route-cell">
                        <button className="pool-expand-button" type="button" onClick={() => toggleExpanded(pool.alias)} aria-expanded={expanded}>
                          <span className="pool-expand-icon" aria-hidden="true">{expanded ? "−" : "+"}</span>
                          <span>{expanded ? `收起 ${routes.length} 个渠道` : `${routes.length} 个渠道`}</span>
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
      <OperationLogSection items={operations} />
    </div>
  );
}

function OperationLogSection({ items }: { items: OperationLogEntry[] }) {
  if (items.length === 0) {
    return (
      <section className="surface operation-log-section">
        <SectionHead title="最近操作" meta="暂无记录" />
        <div className="request-empty compact-log-empty"><Activity size={16} /><strong>暂无操作记录</strong><span>在渠道池执行探测、切换协议等操作后会显示在这里。</span></div>
      </section>
    );
  }
  return (
    <section className="surface operation-log-section">
      <SectionHead title="最近操作" meta={`最近 ${items.length} 条`} />
      <div className="request-table-scroll pool-recent-log-scroll">
        <table className="request-table operation-log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th>详情</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td data-label="时间" className="request-time">{formatRequestTime(new Date(item.createdAt))}</td>
                <td data-label="操作"><strong className="operation-action">{item.action}</strong></td>
                <td data-label="详情" title={item.detail}><span className="operation-detail">{item.detail}</span></td>
                <td data-label="状态"><span className={`request-metric operation-status operation-status-${item.status}`}>{item.status === "running" ? "执行中" : item.status === "success" ? "成功" : item.status === "error" ? "失败" : "信息"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PoolRecentRequestTable({ items, channels }: { items: RequestLogEntry[]; channels: Channel[] }) {
  const channelUrls = new Map(channels.map((channel) => [channel.id, channel.checkinSite?.baseUrl ?? channel.baseUrl]));
  if (items.length === 0) return <div className="request-empty compact-log-empty"><Search size={20} /><strong>暂无最近信息</strong><span>请求经过网关后会显示在这里。</span></div>;
  return (
    <div className="request-table-scroll pool-recent-log-scroll">
      <table className="request-table pool-recent-log-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>来源</th>
            <th>渠道</th>
            <th>模型</th>
            <th>端点</th>
            <th>状态</th>
            <th>错误</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const success = item.statusCode < 400 || item.errorType === "client_closed_request";
            const hasRealError = item.errorType !== null && item.errorType !== "client_closed_request";
            const rowSuccess = !hasRealError && success;
            const date = new Date(item.createdAt);
            const clientLabel = item.clientName === "channel-probe" ? "渠道探测" : item.clientName === "unknown" ? "未知客户端" : item.clientName;
            const channelLabel = item.channelName ?? item.providerName ?? "无可用渠道";
            const channelUrl = item.channelId ? channelUrls.get(item.channelId) : undefined;
            return (
              <tr className={rowSuccess ? "" : "request-row-error"} key={item.id}>
                <td data-label="时间" className="request-time" title={item.requestId}>{formatRequestTime(date)}</td>
                <td data-label="来源"><span className="request-client">{clientLabel}</span></td>
                <td data-label="渠道" title={channelLabel}>
                  {channelUrl ? <a className="request-channel-with-icon request-channel-link" href={channelUrl} target="_blank" rel="noopener noreferrer" title={`新窗口打开 ${channelLabel}`}><span className="request-channel">{channelLabel}</span></a> : <span className="request-channel">{channelLabel}</span>}
                </td>
                <td data-label="模型" title={item.modelAlias}><strong className="request-model-name">{item.modelAlias}</strong></td>
                <td data-label="端点" title={item.endpoint}><code className="request-endpoint">{item.endpoint}</code></td>
                <td data-label="状态"><span className={`request-metric ${rowSuccess ? "good" : "bad"}`}>{rowSuccess ? "成功" : (item.statusCode >= 400 ? `HTTP ${item.statusCode}` : "已拦截")}</span></td>
                <td data-label="错误">{item.errorType && item.errorType !== "client_closed_request" ? <span className="request-error-type" title={item.errorDetail ?? formatErrorType(item.errorType)}>{item.errorDetail ? item.errorDetail : formatErrorType(item.errorType)}</span> : <span className="request-error-none">—</span>}</td>
                <td data-label="耗时"><span className={`request-metric ${rowSuccess ? "good" : "bad"}`}>{formatDuration(item.latencyMs)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
      cache: "no-store",
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

type GatewayLogFilters = { limit: number; offset: number; model: string; channel: string; statusCode: string; errorType: string };
type SystemLogFilters = { limit: number; offset: number; level: string; source: string };

function LogsView({ tab, gatewayPage, systemPage, gatewayFilters, systemFilters, refreshInterval, onRefreshIntervalChange, retentionDays, savingRetention, onRetentionChange, clearing, onClearAll, onGatewayFilterChange, onSystemFilterChange, onGatewayPageChange, onSystemPageChange }: {
  tab: "gateway" | "system";
  gatewayPage: LogPage<GatewayLogEntry> | undefined;
  systemPage: LogPage<SystemLogEntry> | undefined;
  gatewayFilters: GatewayLogFilters;
  systemFilters: SystemLogFilters;
  refreshInterval: number | false;
  onRefreshIntervalChange: (interval: number | false) => void;
  retentionDays: number | null;
  savingRetention: boolean;
  onRetentionChange: (days: number) => void;
  clearing: boolean;
  onClearAll: () => void;
  onGatewayFilterChange: (filters: GatewayLogFilters) => void;
  onSystemFilterChange: (filters: SystemLogFilters) => void;
  onGatewayPageChange: (offset: number) => void;
  onSystemPageChange: (offset: number) => void;
}) {
  const autoRefreshOn = refreshInterval !== false;
  const [copied, setCopied] = useState(false);
  const currentItems = tab === "gateway" ? (gatewayPage?.items ?? []) : (systemPage?.items ?? []);
  const formatLine = tab === "gateway" ? formatGatewayLine : formatSystemLine;
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(currentItems.map((item) => formatLine(item as never)).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="view-stack logs-view">
      <section className="surface logs-surface">
        <div className="logs-toolbar">
          <label className="logs-retention">日志保留
            <select aria-label="日志保留天数" value={retentionDays ?? 7} disabled={savingRetention} onChange={(event) => onRetentionChange(Number(event.target.value))}>
              {[1, 3, 7, 14, 30, 60, 90].map((days) => <option value={days} key={days}>{days} 天</option>)}
            </select>
          </label>
          <span className="logs-toolbar-hint">超过保留天数的日志文件会在启动和每小时自动清理</span>
          <span className="logs-toolbar-actions">
            <span className="auto-refresh-label">自动刷新</span>
            <label className="toggle-switch" title={autoRefreshOn ? "点击关闭自动刷新" : "点击开启自动刷新"}>
              <input type="checkbox" checked={autoRefreshOn} aria-label="自动刷新日志" onChange={(event) => onRefreshIntervalChange(event.target.checked ? 10_000 : false)} />
              <span className="toggle-slider" />
            </label>
            <button className="button secondary small-button" type="button" onClick={() => void copyAll()}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制全部"}</button>
            <button className="button danger-outline small-button" type="button" disabled={clearing} onClick={onClearAll}><Trash2 size={13} /> 清空全部</button>
          </span>
        </div>
        {tab === "gateway" ? <GatewayLogTable page={gatewayPage} filters={gatewayFilters} onFilterChange={onGatewayFilterChange} onPageChange={onGatewayPageChange} /> : <SystemLogTable page={systemPage} filters={systemFilters} onFilterChange={onSystemFilterChange} onPageChange={onSystemPageChange} />}
      </section>
    </div>
  );
}

function LogsSearchInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="logs-search">
      <Search size={14} className="logs-search-icon" />
      <input className="logs-search-input" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value ? <button className="logs-search-clear" type="button" aria-label="清除" onClick={() => onChange("")}><span aria-hidden="true">×</span></button> : null}
    </div>
  );
}

function LogsChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" className={active ? "logs-chip active" : "logs-chip"} onClick={onClick}>{label}</button>;
}

function formatGatewayLine(item: GatewayLogEntry): string {
  const time = new Date(item.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const status = item.statusCode;
  const error = item.errorType ? ` ${formatErrorType(item.errorType)}` : "";
  const retry = item.retryCount > 0 ? ` retry×${item.retryCount}` : "";
  const stream = item.streamed ? "stream" : "sync";
  const tokens = `in=${formatTokens(item.promptTokens)} out=${formatTokens(item.completionTokens)}`;
  return `[${time}] [${status}] [${item.model}] [${item.channelName ?? "—"}]${error} [${stream}] [${tokens}] [${formatDuration(item.latencyMs)}]${retry} ${item.clientName}`;
}

function formatSystemLine(item: SystemLogEntry): string {
  const time = new Date(item.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const level = item.level.toUpperCase().padEnd(5);
  const detail = item.detail ? ` ${JSON.stringify(item.detail)}` : "";
  return `[${time}] [${level}] [${item.source}] ${item.message}${detail}`;
}

function GatewayLogTable({ page, filters, onFilterChange, onPageChange }: { page: LogPage<GatewayLogEntry> | undefined; filters: GatewayLogFilters; onFilterChange: (filters: GatewayLogFilters) => void; onPageChange: (offset: number) => void }) {
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + items.length, total);
  const [expanded, setExpanded] = useState<string | null>(null);
  function update<K extends keyof GatewayLogFilters>(key: K, value: GatewayLogFilters[K]) {
    onFilterChange({ ...filters, [key]: value, offset: 0 });
  }
  return (
    <div className="logs-body">
      <div className="logs-filters">
        <LogsSearchInput value={filters.model} onChange={(value) => update("model", value)} placeholder="按模型筛选" />
        <LogsSearchInput value={filters.channel} onChange={(value) => update("channel", value)} placeholder="按渠道筛选" />
        <LogsSearchInput value={filters.errorType} onChange={(value) => update("errorType", value)} placeholder="错误类型" />
        <span className="logs-filter-stats">{total ? `共 ${total} 条 · 显示 ${from}-${to}` : "暂无日志"}</span>
      </div>
      {items.length === 0
        ? <div className="logs-empty"><Search size={24} /><strong>暂无网关日志</strong><span>网关请求经过后会记录在这里（含上游错误体与重试轨迹）。</span></div>
        : (
          <div className="logs-stream-wrap">
            <div className="logs-stream">
              {items.map((item) => {
                const hasError = item.errorType !== null;
                const isExpanded = expanded === item.requestId;
                return (
                  <Fragment key={item.requestId}>
                    <div className={hasError ? "logs-line logs-line-error" : "logs-line"} onClick={() => setExpanded(isExpanded ? null : item.requestId)} title="点击展开详情">
                      <span className="logs-line-caret">{isExpanded ? "▾" : "▸"}</span>
                      <span className="logs-line-text">{formatGatewayLine(item)}</span>
                    </div>
                    {isExpanded ? <div className="logs-line-detail"><LogDetail entry={item} /></div> : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      <footer className="logs-footer">
        <span>{page?.hasMore ? "还有更多日志" : total ? "已到列表末尾" : "调整筛选条件后重试"}</span>
        <div><button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={filters.offset <= 0} onClick={() => onPageChange(Math.max(0, filters.offset - filters.limit))}><ChevronLeft size={16} /></button><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={!page?.hasMore} onClick={() => onPageChange(filters.offset + filters.limit)}><ChevronRight size={16} /></button></div>
      </footer>
    </div>
  );
}

function LogDetail({ entry }: { entry: GatewayLogEntry }) {
  return (
    <div className="log-detail">
      <div className="log-detail-grid">
        <div><strong>请求 ID</strong><code>{entry.requestId}</code></div>
        <div><strong>类型</strong><span>{entry.kind}</span></div>
        <div><strong>上游模型</strong><span>{entry.upstreamModel ?? "—"}</span></div>
        <div><strong>端点</strong><code>{entry.endpoint ?? "—"}</code></div>
      </div>
      {entry.retryTrace.length > 0 ? (
        <div className="log-detail-block">
          <strong>重试轨迹</strong>
          {entry.retryTrace.map((trace, index) => (
            <div className="log-detail-line" key={`${entry.requestId}-${index}`}>{`#${index + 1} ${trace.channelName ?? "未知渠道"} → ${trace.statusCode} ${trace.errorType ?? ""} (${formatDuration(trace.latencyMs)})`}</div>
          ))}
        </div>
      ) : null}
      {entry.requestBody ? (
        <div className="log-detail-block">
          <strong>请求载荷（脱敏）</strong>
          <pre className="log-detail-pre">{entry.requestBody}</pre>
        </div>
      ) : null}
      {entry.upstreamBody ? (
        <div className="log-detail-block">
          <strong>上游错误响应</strong>
          <pre className="log-detail-pre">{entry.upstreamBody}</pre>
        </div>
      ) : null}
    </div>
  );
}

function SystemLogTable({ page, filters, onFilterChange, onPageChange }: { page: LogPage<SystemLogEntry> | undefined; filters: SystemLogFilters; onFilterChange: (filters: SystemLogFilters) => void; onPageChange: (offset: number) => void }) {
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + items.length, total);
  const [expanded, setExpanded] = useState<string | null>(null);
  function update<K extends keyof SystemLogFilters>(key: K, value: SystemLogFilters[K]) {
    onFilterChange({ ...filters, [key]: value, offset: 0 });
  }
  return (
    <div className="logs-body">
      <div className="logs-filters">
        <div className="logs-chip-group">
          <span className="logs-chip-label">级别</span>
          <LogsChip active={filters.level === ""} label="全部" onClick={() => update("level", "")} />
          <LogsChip active={filters.level === "info"} label="info" onClick={() => update("level", "info")} />
          <LogsChip active={filters.level === "warn"} label="warn" onClick={() => update("level", "warn")} />
          <LogsChip active={filters.level === "error"} label="error" onClick={() => update("level", "error")} />
        </div>
        <LogsSearchInput value={filters.source} onChange={(value) => update("source", value)} placeholder="按来源筛选，如 probe / gateway" />
        <span className="logs-filter-stats">{total ? `共 ${total} 条 · 显示 ${from}-${to}` : "暂无日志"}</span>
      </div>
      {items.length === 0
        ? <div className="logs-empty"><Search size={24} /><strong>暂无系统日志</strong><span>启动、健康检查、签到等系统事件会记录在这里。</span></div>
        : (
          <div className="logs-stream-wrap">
            <div className="logs-stream">
              {items.map((item) => {
                const key = `${item.ts}-${item.source}-${item.message}`;
                const isExpanded = expanded === key;
                return (
                  <Fragment key={key}>
                    <div className={`logs-line logs-line-${item.level}`} onClick={() => setExpanded(isExpanded ? null : key)} title="点击展开详情">
                      <span className="logs-line-caret">{isExpanded ? "▾" : "▸"}</span>
                      <span className="logs-line-text">{formatSystemLine(item)}</span>
                    </div>
                    {isExpanded && item.detail ? <div className="logs-line-detail"><pre className="log-detail-pre">{JSON.stringify(item.detail, null, 2)}</pre></div> : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      <footer className="logs-footer">
        <span>{page?.hasMore ? "还有更多日志" : total ? "已到列表末尾" : "调整筛选条件后重试"}</span>
        <div><button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={filters.offset <= 0} onClick={() => onPageChange(Math.max(0, filters.offset - filters.limit))}><ChevronLeft size={16} /></button><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={!page?.hasMore} onClick={() => onPageChange(filters.offset + filters.limit)}><ChevronRight size={16} /></button></div>
      </footer>
    </div>
  );
}

function RequestsLogsView({ page, channels, filters, refreshInterval, onRefreshIntervalChange, onFilterChange, onPageChange, gatewayPage, systemPage, gatewayFilters, systemFilters, logRefreshInterval, onLogRefreshIntervalChange, retentionDays, savingRetention, onRetentionChange, clearing, onClearAll, onGatewayFilterChange, onSystemFilterChange, onGatewayPageChange, onSystemPageChange }: {
  page: RequestLogPage | undefined;
  channels: Channel[];
  filters: RequestFilters;
  refreshInterval: number | false;
  onRefreshIntervalChange: (interval: number | false) => void;
  onFilterChange: (filters: RequestFilters) => void;
  onPageChange: (offset: number) => void;
  gatewayPage: LogPage<GatewayLogEntry> | undefined;
  systemPage: LogPage<SystemLogEntry> | undefined;
  gatewayFilters: GatewayLogFilters;
  systemFilters: SystemLogFilters;
  logRefreshInterval: number | false;
  onLogRefreshIntervalChange: (interval: number | false) => void;
  retentionDays: number | null;
  savingRetention: boolean;
  onRetentionChange: (days: number) => void;
  clearing: boolean;
  onClearAll: () => void;
  onGatewayFilterChange: (filters: GatewayLogFilters) => void;
  onSystemFilterChange: (filters: SystemLogFilters) => void;
  onGatewayPageChange: (offset: number) => void;
  onSystemPageChange: (offset: number) => void;
}) {
  const [tab, setTab] = useState<"requests" | "gateway" | "system" | "login">("requests");
  const loginHistory = useQuery({ queryKey: ["admin-login-history"], queryFn: api.loginHistory });
  return (
    <div className="view-stack">
      <div className="logs-tabs">
        <button className={tab === "requests" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("requests")}>调用请求</button>
        <button className={tab === "gateway" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("gateway")}>网关日志</button>
        <button className={tab === "system" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("system")}>系统日志</button>
        <button className={tab === "login" ? "logs-tab active" : "logs-tab"} onClick={() => setTab("login")}>登录历史</button>
      </div>
      {tab === "requests"
        ? <RequestsView page={page} channels={channels} filters={filters} refreshInterval={refreshInterval} onRefreshIntervalChange={onRefreshIntervalChange} onFilterChange={onFilterChange} onPageChange={onPageChange} />
        : tab === "login"
          ? <section className="surface logs-surface"><SectionHead title="登录历史" meta="最近 10 条，包含登录 IP" />{loginHistory.isLoading ? <div className="security-empty">正在加载登录记录…</div> : loginHistory.error ? <div className="security-empty danger-text">登录记录加载失败。</div> : loginHistory.data?.length ? <div className="login-history-list">{loginHistory.data.map((record) => <LoginHistoryRow record={record} key={record.id} />)}</div> : <div className="security-empty">暂无登录记录。</div>}</section>
          : <LogsView tab={tab} gatewayPage={gatewayPage} systemPage={systemPage} gatewayFilters={gatewayFilters} systemFilters={systemFilters} refreshInterval={logRefreshInterval} onRefreshIntervalChange={onLogRefreshIntervalChange} retentionDays={retentionDays} savingRetention={savingRetention} onRetentionChange={onRetentionChange} clearing={clearing} onClearAll={onClearAll} onGatewayFilterChange={onGatewayFilterChange} onSystemFilterChange={onSystemFilterChange} onGatewayPageChange={onGatewayPageChange} onSystemPageChange={onSystemPageChange} />}
    </div>
  );
}

function RequestsView({ page, channels, filters, refreshInterval, onRefreshIntervalChange, onFilterChange, onPageChange }: { page: RequestLogPage | undefined; channels: Channel[]; filters: RequestFilters; refreshInterval: number | false; onRefreshIntervalChange: (interval: number | false) => void; onFilterChange: (filters: RequestFilters) => void; onPageChange: (offset: number) => void }) {
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + items.length, total);
  const canPrevious = filters.offset > 0;
  const canNext = Boolean(page?.hasMore);
  const autoRefreshOn = refreshInterval !== false;

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
            <span className="auto-refresh-label">自动刷新</span>
            <label className="toggle-switch" title={autoRefreshOn ? "点击关闭自动刷新" : "点击开启自动刷新"}>
              <input type="checkbox" checked={autoRefreshOn} aria-label="自动刷新调用请求" onChange={(event) => onRefreshIntervalChange(event.target.checked ? 5_000 : false)} />
              <span className="toggle-slider" />
            </label>
          </div>
        </form>
        <RequestTable items={items} channels={channels} />
        <footer className="request-pagination">
          <span>{page?.hasMore ? "还有更多请求" : total ? "已到列表末尾" : "调整筛选条件后重试"}</span>
          <div><button className="icon-button" type="button" title="上一页" aria-label="上一页" disabled={!canPrevious} onClick={() => onPageChange(Math.max(0, filters.offset - filters.limit))}><ChevronLeft size={16} /></button><button className="icon-button" type="button" title="下一页" aria-label="下一页" disabled={!canNext} onClick={() => onPageChange(filters.offset + filters.limit)}><ChevronRight size={16} /></button></div>
        </footer>
      </section>
    </div>
  );
}

function RequestTable({ items, channels }: { items: RequestLogEntry[]; channels: Channel[] }) {
  if (items.length === 0) return <div className="request-empty"><Search size={22} /><strong>暂无请求</strong><span>请求经过网关后会出现在这里。</span></div>;
  const channelUrls = new Map(channels.map((channel) => [channel.id, channel.checkinSite?.baseUrl ?? channel.baseUrl]));
  return (
    <div className="request-table-scroll">
      <table className="request-table">
        <thead><tr><th>时间</th><th>客户端</th><th>来源 IP</th><th>渠道</th><th>密钥</th><th>流式</th><th>错误</th><th>请求模型</th><th>推理强度</th><th>端点</th><th>输入</th><th>输出</th><th>缓存</th><th>耗时</th><th>首字节</th></tr></thead>
        <tbody>{items.map((item) => <RequestRow item={item} channelUrl={item.channelId ? channelUrls.get(item.channelId) : undefined} key={item.id} />)}</tbody>
      </table>
    </div>
  );
}

function RequestRow({ item, channelUrl }: { item: RequestLogEntry; channelUrl: string | undefined }) {
  const success = item.statusCode < 400 || item.errorType === "client_closed_request";
  const hasRealError = item.errorType !== null && item.errorType !== "client_closed_request";
  const rowSuccess = !hasRealError && success;
  const date = new Date(item.createdAt);
  const clientLabel = item.clientName === "unknown" ? "未知客户端" : item.clientName === "channel-probe" ? "渠道探测" : item.clientName;
  const channelLabel = item.channelName ?? item.providerName ?? "无可用渠道";
  return <tr className={rowSuccess ? "" : "request-row-error"}>
    <td data-label="时间" className="request-time">{formatRequestTime(date)}</td>
    <td data-label="客户端"><span className={`request-client request-client-${clientLabel.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`} title={clientLabel}>{clientLabel}</span></td>
    <td data-label="来源 IP" title={item.sourceIp ?? "—"}><span className="request-source-ip">{item.sourceIp ?? "—"}</span></td>
    <td data-label="渠道" title={channelLabel}>
      {channelUrl ? <a className="request-channel-with-icon request-channel-link" href={channelUrl} target="_blank" rel="noopener noreferrer" title={`新窗口打开 ${channelLabel}`}>
        <ChannelSiteIcon channelId={item.channelId} channelName={channelLabel} className="request-channel-icon" />
        <span className="request-channel">{channelLabel}</span>
      </a> : <span className="request-channel-with-icon">
        <ChannelSiteIcon channelId={item.channelId} channelName={channelLabel} className="request-channel-icon" />
        <span className="request-channel">{channelLabel}</span>
      </span>}
    </td>
    <td data-label="密钥" title={item.gatewayKeyName ?? item.keyName ?? "未记录"}><span className="request-key-name">{item.gatewayKeyName ?? item.keyName ?? "未记录"}</span></td>
    <td data-label="流式"><span className={item.streamed ? "request-pill stream" : "request-pill non-stream"}>{item.streamed ? "流式" : "非流式"}</span></td>
    <td data-label="错误">{item.errorType && item.errorType !== "client_closed_request" ? <span className="request-error-type" title={item.errorDetail ?? formatErrorType(item.errorType)}>{item.errorDetail ? item.errorDetail : formatErrorType(item.errorType)}</span> : <span className="request-error-none">—</span>}</td>
    <td data-label="请求模型" title={item.modelAlias}><strong className="request-model-name">{item.modelAlias}</strong></td>
    <td data-label="推理强度"><span className={`request-reasoning${item.reasoningEffort ? " configured" : ""}`} title={item.reasoningEffort ?? ""}>{formatReasoningEffort(item.reasoningEffort)}</span></td>
    <td data-label="端点" title={item.endpoint}><code className="request-endpoint">{item.endpoint}</code></td>
    <td data-label="输入" className="request-number">{formatTokens(item.promptTokens)}</td>
    <td data-label="输出" className="request-number">{formatTokens(item.completionTokens)}</td>
    <td data-label="缓存" className="request-number request-cache">{item.cachedTokens === null ? "—" : formatTokens(item.cachedTokens)}</td>
    <td data-label="耗时"><span className={rowSuccess ? "request-metric good" : "request-metric bad"}>{formatDuration(item.latencyMs)}</span></td>
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

function formatErrorType(value: string) {
  const labels: Record<string, string> = {
    no_route_configured: "未配置路由",
    no_eligible_channel: "无可用渠道",
    channel_unavailable: "渠道不可用",
    unsupported_protocol: "协议不支持",
    all_channels_failed: "全部渠道失败",
    timeout: "上游超时",
    connection_error: "连接失败",
    upstream_rejected: "上游拒绝",
    upstream_auth_failed: "认证失败",
    upstream_5xx: "上游 5xx",
    upstream_overloaded: "上游过载",
    balance_exhausted: "余额不足",
    rate_limited: "触发限流",
    upstream_stream_interrupted: "流式中断",
    client_closed_request: "客户端提前断开",
  };
  return labels[value] ?? value;
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

function SecurityView() {
  const checkinState = useQuery({ queryKey: ["checkin-state"], queryFn: apiCheckin.getState });
  const checkinQueryClient = useQueryClient();
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const notify: SettingsNotify = (title, message) => {
    setSettingsNotice(`${title}：${message}`);
    window.setTimeout(() => setSettingsNotice(null), 4500);
  };
  const settings = checkinState.data?.settings;
  return <div className="view-stack security-view">
    {settingsNotice ? <div className="form-notice" role="status">{settingsNotice}</div> : null}
    <section className="surface checkin-module">
      {checkinState.isLoading ? <div className="security-empty">正在加载签到设置…</div> : checkinState.error ? <div className="security-empty danger-text">签到设置加载失败。</div> : settings ? <SettingsView settings={settings} onSaved={async () => { await checkinQueryClient.invalidateQueries({ queryKey: ["checkin-state"] }); }} notify={notify} /> : <div className="security-empty">暂无签到设置。</div>}
    </section>
  </div>;
}

function LoginHistoryRow({ record }: { record: AdminLoginRecord }) {
  return <div className="login-history-row">
    <span className={`login-result ${record.success ? "success" : "failed"}`}>{record.success ? "成功" : "失败"}</span>
    <span className="login-history-ip" title={record.ip}>{record.ip}</span>
    <span className="login-history-username">{record.username}</span>
    <time className="login-history-time" dateTime={record.createdAt}>{formatDateTime(record.createdAt)}</time>
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
  return { overview: "概览/用量", channels: "渠道/模型池", requests: "日志中心", playground: "模型测试", checkin: "公益站签到", security: "控制面板" }[view];
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

function formatChannelStatus(status: Channel["status"]) {
  const labels: Record<Channel["status"], string> = {
    healthy: "可用",
    degraded: "降级",
    isolated: "已隔离",
    pending: "检测中",
    disabled: "已禁用",
  };
  return labels[status];
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
