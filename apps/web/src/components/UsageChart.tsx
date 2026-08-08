import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Usage } from "../types";

export default function UsageChart({ usage }: { usage: Usage }) {
  const data = usage.timeline.map((point) => ({
    ...point,
    label: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(point.bucket)),
  }));
  if (data.length === 0) return <div className="chart-frame usage-chart"><div className="usage-chart-empty">暂无请求数据</div></div>;
  return (
    <div className="chart-frame usage-chart" aria-label="请求量和失败次数图表">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 14, right: 12, bottom: 4, left: -18 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} minTickGap={34} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ color: "var(--ink)", background: "var(--chart-tooltip)", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "var(--shadow)", fontSize: 12 }}
          />
          <Line type="monotone" dataKey="requests" name="请求次数" className="usage-requests-line" stroke="var(--green)" strokeWidth={2.2} dot={false} activeDot={{ r: 4, className: "usage-active-dot-requests", fill: "var(--green)" }} />
          <Line type="monotone" dataKey="errors" name="失败次数" className="usage-errors-line" stroke="var(--red)" strokeWidth={1.8} dot={false} activeDot={{ r: 3, className: "usage-active-dot-errors", fill: "var(--red)" }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
