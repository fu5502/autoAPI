import type { ChannelStatus } from "../types";

const labels: Record<ChannelStatus, string> = {
  healthy: "可用",
  degraded: "降级",
  isolated: "已隔离",
  pending: "检测中",
  disabled: "已禁用",
};

export function StatusDot({ status }: { status: ChannelStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
