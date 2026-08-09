import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical, Pause, Pencil, Play, RefreshCw, Trash2, WalletCards } from "lucide-react";
import type { Channel } from "../types";
import { getAdminToken } from "../api";
import { StatusDot } from "./StatusDot";
import { isLowBalance } from "../checkin/format";

export function ChannelTable({
  channels,
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
  channels: Channel[];
  syncingBalanceId: number | null;
  balanceRefreshPending: boolean;
  onSyncBalance: (siteId: number) => void;
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel, enabled?: boolean) => void;
  togglingId: string | null;
  deletingId: string | null;
  onReorder: (channelIds: string[]) => Promise<void>;
}) {
  const [orderedChannels, setOrderedChannels] = useState(channels);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [expandedChannelIds, setExpandedChannelIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!draggingId && !savingOrder) setOrderedChannels(channels);
  }, [channels, draggingId, savingOrder]);

  async function dropChannel(targetId: string) {
    if (!draggingId || draggingId === targetId || savingOrder) return;
    const fromIndex = orderedChannels.findIndex((channel) => channel.id === draggingId);
    const targetIndex = orderedChannels.findIndex((channel) => channel.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const next = [...orderedChannels];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    setDraggingId(null);
    setDropTargetId(null);
    setOrderedChannels(next);
    setSavingOrder(true);
    try {
      await onReorder(next.map((channel) => channel.id));
    } catch {
      setOrderedChannels(channels);
    } finally {
      setSavingOrder(false);
    }
  }

  function toggleExpanded(channelId: string) {
    setExpandedChannelIds((current) => {
      const next = new Set(current);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  return (
    <div className="table-scroll">
      <table className="channel-table">
        <thead><tr><th>渠道名称</th><th>密钥名称</th><th>Base URL</th><th>模型数</th><th>优先级</th><th>权重</th><th>状态</th><th>协议</th><th>余额</th><th>延迟</th><th>健康百分比</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>
          {orderedChannels.length === 0 ? <tr><td className="empty-table-cell" colSpan={12}>暂无渠道，请先添加一个渠道。</td></tr> : orderedChannels.map((channel) => {
            const expanded = expandedChannelIds.has(channel.id);
            return <Fragment key={channel.id}>
              <tr
                className={`channel-row ${draggingId === channel.id ? "channel-row-dragging " : ""}${dropTargetId === channel.id ? "channel-row-drop-target" : ""}`}
                onDragOver={(event) => {
                  if (!draggingId || draggingId === channel.id || savingOrder) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(channel.id);
                }}
                onDrop={(event) => {
                  if (!draggingId || savingOrder) return;
                  event.preventDefault();
                  void dropChannel(channel.id);
                }}
              >
                <td>
                  <div className="channel-name">
                    <span
                      className="channel-drag-handle"
                      title="拖拽调整渠道优先级"
                      aria-label="拖拽调整渠道优先级"
                      draggable={!savingOrder}
                      onDragStart={(event) => {
                        setDraggingId(channel.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", channel.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropTargetId(null);
                      }}
                    ><GripVertical size={15} /></span>
                    <button
                      className="channel-expand-button"
                      type="button"
                      title={expanded ? "收起模型列表" : "展开模型列表"}
                      aria-label={`${expanded ? "收起" : "展开"}${channel.name}的模型列表`}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(channel.id);
                      }}
                    >
                      {expanded ? <ChevronDown className="channel-expand-icon" size={14} aria-hidden="true" /> : <ChevronRight className="channel-expand-icon" size={14} aria-hidden="true" />}
                    </button>
                    <ChannelSiteIcon channel={channel} />
                    <div><strong>{channel.name}</strong></div>
                  </div>
                </td>
                <td><span className="channel-key-name">{channel.keyName ?? "API Key"}</span></td>
                <td>
                  <div className="channel-base-url-cell">
                    <a className="channel-base-url" href={channel.baseUrl} target="_blank" rel="noopener noreferrer" title={`新窗口打开 ${channel.baseUrl}`}>{channel.baseUrl}</a>
                  </div>
                </td>
                <td><span className="channel-model-count">{channel.models.length}</span></td>
                <td><strong className="channel-routing-number">{channel.priority}</strong></td>
                <td><span className="channel-routing-number">{channel.weight}</span></td>
                <td><ChannelStatusControl channel={channel} pending={togglingId === channel.id} onToggle={onToggle} /></td>
                <td><span className="mono subtle">{channel.protocol}</span></td>
                <td>{formatBalance(channel, onSyncBalance, syncingBalanceId, balanceRefreshPending)}</td>
                <td>{channel.lastLatencyMs === null ? "—" : `${channel.lastLatencyMs} ms`}</td>
                <td className={channel.recentRequestCount === 0 ? "subtle" : channel.recentErrorRate > 0.2 ? "danger-text" : channel.recentErrorRate > 0.05 ? "warning-text" : "success-text"}>{channel.recentRequestCount === 0 ? "—" : formatPercent(1 - channel.recentErrorRate)}</td>
                <td>
                  <div className="table-actions">
                    {channel.checkinSite ? <button className="icon-button" type="button" title={syncingBalanceId === channel.checkinSite.id ? "同步中…" : "同步签到站余额"} aria-label={`${syncingBalanceId === channel.checkinSite.id ? "同步中" : "同步"}${channel.checkinSite.name}余额`} disabled={syncingBalanceId !== null} onClick={() => onSyncBalance(channel.checkinSite!.id)}>
                      <WalletCards size={15} className={syncingBalanceId === channel.checkinSite.id ? "spin" : ""} />
                    </button> : null}
                    <button className="icon-button" type="button" title="探测渠道" aria-label={`探测${channel.name}`} disabled={probingId === channel.id} onClick={() => onProbe(channel.id)}>
                      <RefreshCw size={15} className={probingId === channel.id ? "spin" : ""} />
                    </button>
                    <button className="icon-button" type="button" title="编辑渠道" aria-label={`编辑${channel.name}`} onClick={() => onEdit(channel)}>
                      <Pencil size={15} />
                    </button>
                    <button className="icon-button" type="button" title={channel.enabled ? "停用渠道" : "启用渠道"} aria-label={`${channel.enabled ? "停用" : "启用"}${channel.name}`} disabled={togglingId === channel.id} onClick={() => onToggle(channel)}>
                      {channel.enabled ? <Pause size={15} /> : <Play size={15} />}
                    </button>
                    <button className="icon-button danger-button" type="button" title="删除渠道" aria-label={`删除${channel.name}`} disabled={deletingId !== null} onClick={() => onDelete(channel)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
              {expanded ? <tr className="channel-models-row"><td colSpan={12}>
                <div className="channel-models-detail">
                  <div className="channel-models-head"><strong>模型列表</strong><span>{channel.models.length} 个模型</span></div>
                  {channel.models.length > 0 ? <div className="channel-model-list">{channel.models.map((model, index) => <span className="channel-model-chip" key={`${model}-${index}`}>{model}</span>)}</div> : <span className="subtle">未配置模型</span>}
                </div>
              </td></tr> : null}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChannelStatusControl({ channel, pending, onToggle }: { channel: Channel; pending: boolean; onToggle: (channel: Channel, enabled?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  function choose(enabled: boolean) {
    setOpen(false);
    onToggle(channel, enabled);
  }

  const isIsolated = channel.status === "isolated";
  const actionLabel = isIsolated ? "启用" : channel.enabled ? "停用" : "可用";
  const actionTitle = isIsolated ? `启用${channel.name}` : channel.enabled ? `停用${channel.name}` : `启用${channel.name}`;
  const actionEnabled = isIsolated ? true : !channel.enabled;

  return (
    <div className="channel-status-cell" ref={menuRef}>
      <button
        className="channel-status-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${channel.name}当前状态，修改渠道状态`}
        title="点击修改渠道状态"
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <StatusDot status={channel.status} />
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {channel.status === "isolated" ? <IsolationCountdown until={channel.cooldownUntil} /> : null}
      {open ? <div className="channel-status-menu" role="menu">
        <button type="button" role="menuitem" disabled={pending} title={actionTitle} onClick={() => choose(actionEnabled)}>{actionLabel}</button>
      </div> : null}
    </div>
  );
}

function IsolationCountdown({ until }: { until: string | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  const expiresAt = until ? Date.parse(until) : Number.NaN;
  const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : null;
  const label = remainingMs === null ? "等待重新检测" : remainingMs > 0 ? `重试 ${formatCountdown(remainingMs)}` : "等待重新检测";
  return <span className="isolation-countdown" aria-label={`隔离状态${label}`}>{label}</span>;
}

function formatCountdown(valueMs: number) {
  const totalSeconds = Math.ceil(valueMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function ChannelSiteIcon({ channel }: { channel: Channel }) {
  const site = channel.checkinSite;
  const iconUrl = `/admin/channels/${encodeURIComponent(channel.id)}/favicon`;
  const [iconSrc, setIconSrc] = useState<string | null>(null);
  const [iconUnavailable, setIconUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setIconSrc(null);
    setIconUnavailable(false);

    void fetch(iconUrl, { cache: "force-cache", headers: { Authorization: `Bearer ${getAdminToken()}` }, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Site icon is unavailable");
        return response.blob();
      })
      .then((blob) => {
        if (!blob.size) throw new Error("Site icon is empty");
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setIconSrc(objectUrl);
      })
      .catch(() => {
        if (!active) return;
        setIconUnavailable(true);
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [channel.baseUrl, channel.faviconUrl, iconUrl]);

  const label = site?.name ?? channel.name;
  const fallback = iconUnavailable || !iconSrc;
  return (
    <span className="channel-site-icon" title={site ? `关联签到站：${site.name}` : "渠道站点图标"} aria-label={site ? `关联签到站：${site.name}` : "渠道站点图标"}>
      {fallback ? <span className="channel-site-icon-fallback" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span> : <img src={iconSrc} alt="" loading="lazy" decoding="async" onError={() => { setIconSrc(null); setIconUnavailable(true); }} />}
    </span>
  );
}

function formatBalance(channel: Channel, onSyncBalance: (siteId: number) => void, syncingBalanceId: number | null, balanceRefreshPending: boolean) {
  const value = channel.balance === null ? null : `${channel.balanceCurrency === "USD" ? "$" : `${channel.balanceCurrency ?? ""} `}${formatBalanceValue(channel.balance)}`;
  const balanceClass = channel.balance === null ? "unknown" : isLowBalance(channel.balance) ? "low" : channel.balanceStatus;
  const refreshedAt = channel.checkinSite?.lastBalanceUpdatedAt ?? channel.balanceUpdatedAt ?? null;
  const refreshLabel = formatBalanceRefreshTime(refreshedAt);
  const balanceContent = <>
    {syncingBalanceId === channel.checkinSite?.id || balanceRefreshPending ? <RefreshCw size={13} className="spin" aria-hidden="true" /> : <span className="channel-balance-mark" aria-hidden="true" />}
    {value === null ? <span>未知</span> : <strong>{value}</strong>}
  </>;
  if (channel.checkinSite) {
    const syncing = syncingBalanceId === channel.checkinSite.id || balanceRefreshPending;
    const disabled = syncingBalanceId !== null || balanceRefreshPending;
    return <div className="channel-balance-cell"><button className={`channel-balance channel-balance-${balanceClass} channel-balance-button`} type="button" title={syncing ? "同步中…" : disabled ? "另一个签到站正在同步" : "点击余额同步签到站余额"} aria-label={`${syncing ? "同步中" : "同步"}${channel.checkinSite.name}余额`} disabled={disabled} onClick={(event) => {
      event.stopPropagation();
      onSyncBalance(channel.checkinSite!.id);
    }}>{balanceContent}</button><small className="channel-balance-time">{refreshLabel}</small></div>;
  }
  if (value === null) {
    return <div className="channel-balance-cell"><span className="channel-balance channel-balance-unknown" title="当前余额未知">{balanceContent}</span><small className="channel-balance-time">{refreshLabel}</small></div>;
  }
  return <div className="channel-balance-cell"><span className={`channel-balance channel-balance-${channel.balanceStatus}`} title={`当前余额 ${value}`}>{balanceContent}</span><small className="channel-balance-time">{refreshLabel}</small></div>;
}

function formatBalanceRefreshTime(value: string | null): string {
  if (!value) return "尚未刷新";
  return `刷新于 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value))}`;
}

function formatBalanceValue(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}
