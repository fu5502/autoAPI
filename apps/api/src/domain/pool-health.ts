import type { PoolHealthMetrics, PoolHealthPoint, PoolHealthStatus, UsageEventInput } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;
const HALF_DAY_HOURS = 12;
const WEEK_DAYS = 7;
const ONE_HOUR_MS = HOUR_MS;
const TWELVE_HOURS_MS = 12 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const RECENT_WINDOW_MS = 6 * HOUR_MS;
const RECENT_BUCKET_MS = 5 * 60 * 1000;
const RECENT_BUCKETS = RECENT_WINDOW_MS / RECENT_BUCKET_MS;
const ONE_HOUR_BUCKETS = ONE_HOUR_MS / RECENT_BUCKET_MS;

type UsageEvent = UsageEventInput & { createdAt: string };

export function buildPoolHealth(events: readonly UsageEvent[], now = Date.now()): PoolHealthMetrics {
  const healthEvents = events.filter(isHealthRelevantEvent);
  const dayAgo = now - DAY_HOURS * HOUR_MS;
  const weekAgo = now - WEEK_MS;
  const fifteenMinutesAgo = now - 15 * 60 * 1000;
  const events24h = healthEvents.filter((event) => Date.parse(event.createdAt) >= dayAgo);
  const events6h = healthEvents.filter((event) => Date.parse(event.createdAt) >= now - RECENT_WINDOW_MS);
  const events7d = healthEvents.filter((event) => Date.parse(event.createdAt) >= weekAgo);
  const events15m = healthEvents.filter((event) => Date.parse(event.createdAt) >= fifteenMinutesAgo);
  const health1h = createRecentHealth(now, ONE_HOUR_MS);
  const recentHealth = createRecentHealth(now);
  const health12h = createHourlyHealth(now, HALF_DAY_HOURS);
  const hourlyHealth = createHourlyHealth(now);
  const health7d = createDailyHealth(now);

  aggregateEvents(healthEvents.filter((event) => Date.parse(event.createdAt) >= now - ONE_HOUR_MS), health1h, RECENT_BUCKET_MS);
  aggregateEvents(events6h, recentHealth, RECENT_BUCKET_MS);
  aggregateEvents(healthEvents.filter((event) => Date.parse(event.createdAt) >= now - TWELVE_HOURS_MS), health12h, HOUR_MS);
  aggregateEvents(events24h, hourlyHealth, HOUR_MS);
  aggregateEvents(events7d, health7d, 24 * HOUR_MS);

  const successfulRequests24h = events24h.filter((event) => event.statusCode < 400).length;
  const successfulRequests6h = events6h.filter((event) => event.statusCode < 400).length;
  return {
    requests24h: events24h.length,
    successfulRequests24h,
    successRate24h: successRate(events24h.length, successfulRequests24h),
    requests6h: events6h.length,
    successfulRequests6h,
    successRate6h: successRate(events6h.length, successfulRequests6h),
    requests15m: events15m.length,
    averageLatencyMs15m: average(events15m.map((event) => event.latencyMs)),
    peakLatencyMs15m: max(events15m.map((event) => event.latencyMs)),
    health1h,
    hourlyHealth,
    recentHealth,
    health12h,
    health7d,
  };
}

export const PROBE_CLIENT_NAME = "channel-probe";

export function isHealthRelevantEvent(event: Pick<UsageEventInput, "errorType" | "clientName">): boolean {
  if (event.errorType === "client_closed_request") return false;
  if (event.clientName === PROBE_CLIENT_NAME) return false;
  return true;
}

export function createHourlyHealth(now = Date.now(), hours = DAY_HOURS): PoolHealthPoint[] {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  return createHealthPoints(currentHour, hours, HOUR_MS);
}

export function createRecentHealth(now = Date.now(), windowMs = RECENT_WINDOW_MS): PoolHealthPoint[] {
  const currentBucket = Math.floor(now / RECENT_BUCKET_MS) * RECENT_BUCKET_MS;
  return createHealthPoints(currentBucket, windowMs / RECENT_BUCKET_MS, RECENT_BUCKET_MS);
}

export function createDailyHealth(now = Date.now(), days = WEEK_DAYS): PoolHealthPoint[] {
  const currentDay = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  return createHealthPoints(currentDay, days, 24 * HOUR_MS);
}

function createHealthPoints(currentBucket: number, count: number, bucketMs: number): PoolHealthPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    bucket: new Date(currentBucket - (count - 1 - index) * bucketMs).toISOString(),
    requests: 0,
    successfulRequests: 0,
    successRate: null,
    averageLatencyMs: 0,
    peakLatencyMs: 0,
    status: "no_request" as PoolHealthStatus,
  }));
}

function aggregateEvents(events: readonly UsageEvent[], points: PoolHealthPoint[], bucketMs: number): void {
  const firstBucket = Date.parse(points[0]?.bucket ?? "");
  for (const event of events) {
    const timestamp = Date.parse(event.createdAt);
    const index = Math.floor((timestamp - firstBucket) / bucketMs);
    const point = points[index];
    if (!point) continue;
    point.requests += 1;
    if (event.statusCode < 400) point.successfulRequests += 1;
    point.averageLatencyMs += event.latencyMs;
    point.peakLatencyMs = Math.max(point.peakLatencyMs, event.latencyMs);
  }
  for (const point of points) finalizeHealthPoint(point);
}

export function finalizeHealthPoint(point: PoolHealthPoint): PoolHealthPoint {
  point.successRate = successRate(point.requests, point.successfulRequests);
  point.averageLatencyMs = point.requests ? Math.round(point.averageLatencyMs / point.requests) : 0;
  point.status = healthStatus(point.requests, point.successfulRequests);
  return point;
}

export function healthStatus(requests: number, successfulRequests: number): PoolHealthStatus {
  if (requests === 0) return "no_request";
  const rate = successfulRequests / requests;
  if (rate >= 0.95) return "available";
  if (rate >= 0.8) return "degraded";
  return "abnormal";
}

function successRate(requests: number, successfulRequests: number): number | null {
  return requests ? successfulRequests / requests : null;
}

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function max(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}
