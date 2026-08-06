import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Usage } from "../types";

export default function UsageChart({ usage }: { usage: Usage }) {
  const data = usage.timeline.map((point) => ({
    ...point,
    label: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(point.bucket)),
  }));
  return (
    <div className="chart-frame" aria-label="请求量图表">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 10, bottom: 4, left: -24 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} minTickGap={34} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ color: "var(--ink)", background: "var(--chart-tooltip)", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "var(--shadow)", fontSize: 12 }}
            formatter={(value, name) => [value, name === "requests" ? "请求数" : "错误数"]}
          />
          <Line type="monotone" dataKey="requests" stroke="#216e5b" strokeWidth={2.2} dot={false} activeDot={{ r: 4, fill: "#216e5b" }} />
          <Line type="monotone" dataKey="errors" stroke="#c7512d" strokeWidth={1.6} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
