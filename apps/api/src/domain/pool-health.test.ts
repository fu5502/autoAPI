import { describe, expect, it } from "vitest";
import { buildPoolHealth, healthStatus } from "./pool-health.js";
import type { UsageEventInput } from "./types.js";

const now = Date.parse("2026-08-04T12:34:00.000Z");

describe("pool health metrics", () => {
  it("builds 24 hourly points and classifies their success rate", () => {
    const events = [
      event("2026-08-04T12:00:10.000Z", 200, 100),
      event("2026-08-04T12:10:10.000Z", 200, 120),
      event("2026-08-04T12:20:10.000Z", 500, 300),
      event("2026-08-04T11:20:10.000Z", 500, 300),
      event("2026-08-04T11:30:10.000Z", 200, 200),
      event("2026-08-03T12:00:00.000Z", 200, 50),
    ];

    const metrics = buildPoolHealth(events, now);
    expect(metrics.health1h).toHaveLength(12);
    expect(metrics.health12h).toHaveLength(12);
    expect(metrics.health7d).toHaveLength(7);
    expect(metrics.hourlyHealth).toHaveLength(24);
    expect(metrics.requests24h).toBe(5);
    expect(metrics.successfulRequests24h).toBe(3);
    expect(metrics.successRate24h).toBe(0.6);
    expect(metrics.requests15m).toBe(1);
    expect(metrics.averageLatencyMs15m).toBe(300);
    expect(metrics.peakLatencyMs15m).toBe(300);
    expect(metrics.hourlyHealth.at(-1)).toMatchObject({ requests: 3, successfulRequests: 2, successRate: 2 / 3, status: "abnormal" });
    expect(metrics.hourlyHealth.at(-2)).toMatchObject({ requests: 2, successfulRequests: 1, successRate: 0.5, status: "abnormal" });
    expect(metrics.hourlyHealth.at(-3)).toMatchObject({ requests: 0, successfulRequests: 0, successRate: null, status: "no_request" });
  });

  it("uses the dashboard thresholds", () => {
    expect(healthStatus(100, 95)).toBe("available");
    expect(healthStatus(100, 80)).toBe("degraded");
    expect(healthStatus(100, 79)).toBe("abnormal");
    expect(healthStatus(0, 0)).toBe("no_request");
  });

  it("builds 72 five-minute points for the recent health window", () => {
    const metrics = buildPoolHealth([
      event("2026-08-04T12:30:10.000Z", 200, 100),
      event("2026-08-04T12:31:10.000Z", 503, 200),
    ], now);
    expect(metrics.recentHealth).toHaveLength(72);
    expect(metrics.requests6h).toBe(2);
    expect(metrics.successfulRequests6h).toBe(1);
    expect(metrics.successRate6h).toBe(0.5);
    expect(metrics.recentHealth.find((point) => point.requests === 2)).toMatchObject({ successfulRequests: 1, status: "abnormal" });
  });

  it("excludes client-cancelled requests from health metrics", () => {
    const cancelled = event("2026-08-04T12:31:10.000Z", 499, 150);
    cancelled.errorType = "client_closed_request";
    const metrics = buildPoolHealth([
      event("2026-08-04T12:30:10.000Z", 200, 100),
      cancelled,
    ], now);

    expect(metrics.requests24h).toBe(1);
    expect(metrics.successfulRequests24h).toBe(1);
    expect(metrics.successRate24h).toBe(1);
    expect(metrics.health12h.at(-1)).toMatchObject({
      requests: 1,
      successfulRequests: 1,
      successRate: 1,
    });
  });

  it("excludes channel probe requests from health metrics", () => {
    const probe = event("2026-08-04T12:31:10.000Z", 200, 100);
    probe.clientName = "channel-probe";
    const metrics = buildPoolHealth([
      event("2026-08-04T12:30:10.000Z", 200, 100),
      probe,
    ], now);

    expect(metrics.requests24h).toBe(1);
    expect(metrics.successfulRequests24h).toBe(1);
    expect(metrics.successRate24h).toBe(1);
  });
});

function event(createdAt: string, statusCode: number, latencyMs: number): UsageEventInput & { createdAt: string } {
  return {
    requestId: `${createdAt}-${statusCode}`,
    channelId: "channel",
    modelAlias: "model",
    upstreamModel: "model",
    clientName: "test",
    requestKind: "chat",
    statusCode,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs,
    errorType: statusCode >= 400 ? "upstream_5xx" : null,
    retryCount: 0,
    streamed: false,
    createdAt,
  };
}
