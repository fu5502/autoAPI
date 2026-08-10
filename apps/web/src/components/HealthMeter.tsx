import type { ReactNode } from "react";

export type HealthMeterTone = "good" | "warn" | "bad" | "none";

export function HealthMeter({
  percent,
  tone,
  value,
  label,
}: {
  percent: number | null;
  tone: HealthMeterTone;
  value: ReactNode;
  label: string;
}) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className={`health-meter health-meter-${tone}`} role="img" aria-label={label}>
      <span className="health-meter-value">{value}</span>
      <span className="health-meter-track" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
      </span>
    </div>
  );
}
