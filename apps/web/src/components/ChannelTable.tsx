import { Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import type { Channel } from "../types";
import { StatusDot } from "./StatusDot";

export function ChannelTable({
  channels,
  probingId,
  onProbe,
  onEdit,
  onDelete,
  onToggle,
  togglingId,
  deletingId,
}: {
  channels: Channel[];
  probingId: string | null;
  onProbe: (id: string) => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToggle: (channel: Channel) => void;
  togglingId: string | null;
  deletingId: string | null;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>渠道</th><th>状态</th><th>协议</th><th>余额</th><th>延迟</th><th>错误率</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>
          {channels.length === 0 ? <tr><td className="empty-table-cell" colSpan={7}>暂无渠道，请先添加一个渠道。</td></tr> : channels.map((channel) => (
            <tr key={channel.id}>
              <td>
                <div className="channel-name"><strong>{channel.name}</strong><span>{channel.baseUrl.replace(/^https?:\/\//, "")}</span></div>
              </td>
              <td><StatusDot status={channel.status} /></td>
              <td><span className="mono subtle">{channel.protocol}</span></td>
              <td>{formatBalance(channel)}</td>
              <td>{channel.lastLatencyMs === null ? "—" : `${channel.lastLatencyMs} ms`}</td>
              <td className={channel.recentErrorRate > 0.1 ? "danger-text" : ""}>{formatPercent(channel.recentErrorRate)}</td>
              <td>
                <div className="table-actions">
                <button className="icon-button" title="探测渠道" aria-label={`探测${channel.name}`} disabled={probingId === channel.id} onClick={() => onProbe(channel.id)}>
                  <RefreshCw size={15} className={probingId === channel.id ? "spin" : ""} />
                </button>
                <button className="icon-button" title="编辑渠道" aria-label={`编辑${channel.name}`} onClick={() => onEdit(channel)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-button" title={channel.enabled ? "停用渠道" : "启用渠道"} aria-label={`${channel.enabled ? "停用" : "启用"}${channel.name}`} disabled={togglingId === channel.id} onClick={() => onToggle(channel)}>
                  {channel.enabled ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button className="icon-button danger-button" title="删除渠道" aria-label={`删除${channel.name}`} disabled={deletingId !== null} onClick={() => onDelete(channel)}>
                  <Trash2 size={15} />
                </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBalance(channel: Channel) {
  if (channel.balance === null) return <span className="subtle">未知</span>;
  return <span className={channel.balanceStatus === "low" || channel.balanceStatus === "exhausted" ? "danger-text" : ""}>
    {channel.balanceCurrency === "USD" ? "$" : `${channel.balanceCurrency ?? ""} `}{channel.balance.toFixed(2)}
  </span>;
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}
