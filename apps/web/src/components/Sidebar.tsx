import { BadgeCheck, Boxes, ClipboardList, FlaskConical, Gauge, Github, Network, ShieldCheck } from "lucide-react";
import type { View } from "../types";

const nav = [
  { id: "overview" as const, label: "概览/用量", icon: Gauge },
  { id: "channels" as const, label: "渠道/模型池", icon: Boxes },
  { id: "requests" as const, label: "日志中心", icon: ClipboardList },
  { id: "playground" as const, label: "模型测试", icon: FlaskConical },
  { id: "checkin" as const, label: "公益站签到", icon: BadgeCheck },
  { id: "security" as const, label: "控制面板", icon: ShieldCheck },
];

export function Sidebar({ view, onChange, version, versionOutdated, latestVersion }: { view: View; onChange: (view: View) => void; version: string; versionOutdated?: boolean; latestVersion?: string | null }) {
  const title = versionOutdated && latestVersion
    ? `当前版本 ${version} 不是最新\n最新版本 ${latestVersion}\n点击查看 GitHub 仓库`
    : "autoAPI GitHub 项目地址";
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
        <a className={"sidebar-version" + (versionOutdated ? " version-outdated" : "")} href="https://github.com/fu5502/autoAPI" target="_blank" rel="noreferrer" title={title}>
          <Github size={14} />
          <span>v{version}</span>
        </a>
      </div>
    </aside>
  );
}
