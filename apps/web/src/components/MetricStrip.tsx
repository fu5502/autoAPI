import { Clock3, Layers3, RadioTower, ShieldCheck } from "lucide-react";
import type { GatewayStatus } from "../types";

export function MetricStrip({ status }: { status: GatewayStatus }) {
  const values = [
    { label: "可用渠道", value: `${status.healthyChannels}/${status.channels}`, icon: ShieldCheck, tone: "green" },
    { label: "模型池", value: String(status.modelPools), icon: Layers3, tone: "ink" },
    { label: "请求数 / 24 小时", value: formatNumber(status.requests24h), icon: RadioTower, tone: "blue" },
    { label: "平均延迟", value: `${status.averageLatencyMs24h} ms`, icon: Clock3, tone: "amber" },
  ];
  return (
    <section className="metric-strip" aria-label="网关状态">
      {values.map(({ label, value, icon: Icon, tone }) => (
        <div className="metric" key={label}>
          <span className={`metric-icon tone-${tone}`}><Icon size={17} /></span>
          <div><span>{label}</span><strong>{value}</strong></div>
        </div>
      ))}
    </section>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: value > 9_999 ? "compact" : "standard" }).format(value);
}
