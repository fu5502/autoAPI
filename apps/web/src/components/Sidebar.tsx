import { Activity, BadgeCheck, Boxes, Cable, ClipboardList, FlaskConical, Gauge, Network, ShieldCheck } from "lucide-react";
import type { View } from "../types";

const nav = [
  { id: "overview" as const, label: "概览", icon: Gauge },
  { id: "channels" as const, label: "渠道", icon: Cable },
  { id: "pools" as const, label: "模型池", icon: Boxes },
  { id: "usage" as const, label: "用量", icon: Activity },
  { id: "requests" as const, label: "调用请求", icon: ClipboardList },
  { id: "playground" as const, label: "模型测试", icon: FlaskConical },
  { id: "checkin" as const, label: "公益站签到", icon: BadgeCheck },
  { id: "security" as const, label: "安全设置", icon: ShieldCheck },
];

export function Sidebar({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Network size={18} strokeWidth={2.2} /></span>
        <span>autoAPI</span>
      </div>
      <nav className="side-nav" aria-label="主导航">
        {nav.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => onChange(id)}>
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="live-dot" />
        控制面板在线
      </div>
    </aside>
  );
}
