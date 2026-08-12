import { mkdir, readFile, readdir, unlink, writeFile, appendFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const RETENTION_DAYS = 7;
const MAX_BODY_CHARS = 8_000;
const MAX_ENTRY_CHARS = 20_000;
// Resolve to the repository root (this file lives at src/logger/, one level
// deeper than app.ts) so logs land next to the project-level .autoapi-data.
const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface GatewayLogFilters {
  limit: number;
  offset: number;
  startTime?: string;
  endTime?: string;
  model?: string;
  channel?: string;
  statusCode?: string;
  errorType?: string;
}

export interface SystemLogFilters {
  limit: number;
  offset: number;
  level?: string;
  source?: string;
  startTime?: string;
  endTime?: string;
}

export interface GatewayLogEntry {
  ts: string;
  requestId: string;
  kind: string;
  model: string;
  channelId: string | null;
  channelName: string | null;
  upstreamModel: string | null;
  statusCode: number;
  errorType: string | null;
  errorDetail: string | null;
  upstreamBody: string | null;
  requestBody: string | null;
  retryCount: number;
  retryTrace: RetryTraceEntry[];
  latencyMs: number;
  streamed: boolean;
  clientName: string;
  endpoint: string | null;
  promptTokens: number;
  completionTokens: number;
}

export interface RetryTraceEntry {
  channelName: string | null;
  statusCode: number;
  errorType: string | null;
  latencyMs: number;
}

export interface SystemLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  detail: Record<string, unknown> | null;
}

export interface LogPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * 脱敏：打码 Bearer / sk- 等密钥形态，并截断长度。供网关日志、系统日志
 * 以及 proxy-routes 的网关错误响应复用，保证所有落库内容一致脱敏。
 */
export function sanitizeMessage(input: string, maxChars = 500): string {
  const cleaned = input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\b(api[-_ ]?key|token|authorization)\s*[:=]\s*["']?[^\s"']+/gi, "$1=[redacted]");
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

const SENSITIVE_KEY = /^(?:api[_-]?key|key|secret|password|authorization|credential|token)$/i;

function deepSanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return sanitizeMessage(value, MAX_BODY_CHARS);
  if (Array.isArray(value)) return value.map((item) => deepSanitize(item, depth + 1)).slice(0, 200);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = deepSanitize(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function serializeSanitized(value: unknown): string {
  if (typeof value === "string" && value.length > MAX_ENTRY_CHARS) {
    return `${sanitizeMessage(value.slice(0, MAX_ENTRY_CHARS), MAX_ENTRY_CHARS)}…[truncated]`;
  }
  let text: string;
  try {
    text = JSON.stringify(deepSanitize(value));
  } catch {
    text = `[unserializable:${typeof value}]`;
  }
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…[truncated]` : text;
}

export class DiagnosticLogger {
  private readonly logDir: string;
  private gatewayQueue: Promise<void> = Promise.resolve();
  private systemQueue: Promise<void> = Promise.resolve();
  private dirReady: Promise<void> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private retentionDays: number;

  constructor(dataDir: string, retentionDays = RETENTION_DAYS) {
    this.logDir = isAbsolute(dataDir)
      ? join(dataDir, "logs")
      : resolve(PROJECT_ROOT, dataDir, "logs");
    this.retentionDays = clampRetention(retentionDays);
  }

  async init(): Promise<void> {
    this.dirReady = mkdir(this.logDir, { recursive: true }).then(() => undefined);
    await this.dirReady;
    await this.cleanup();
  }

  /**
   * 删除超过保留天数的日志文件。手动触发或定时自动清理共用。
   * @returns 本次删除的文件数量
   */
  async cleanup(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const files = await readdir(this.logDir).catch(() => []);
    let removed = 0;
    for (const file of files) {
      const match = /^(?:gateway|system)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (!match) continue;
      const day = new Date(`${match[1]}T00:00:00Z`);
      if (day < cutoff) {
        await unlink(join(this.logDir, file)).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }

  /** 清空全部网关/系统日志文件。 */
  async clearAll(): Promise<number> {
    const files = await readdir(this.logDir).catch(() => []);
    let removed = 0;
    for (const file of files) {
      if (/^(?:gateway|system)-.+\.jsonl$/.test(file)) {
        await unlink(join(this.logDir, file)).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }

  getRetentionDays(): number {
    return this.retentionDays;
  }

  setRetentionDays(days: number): void {
    this.retentionDays = clampRetention(days);
  }

  /** 启动定时自动清理（幂等，重复调用会替换定时器）。 */
  startAutoCleanup(intervalMs: number): void {
    this.stopAutoCleanup();
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.cleanup().catch(() => undefined);
      }, intervalMs);
      this.cleanupTimer.unref();
    }
  }

  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async logGateway(entry: Omit<GatewayLogEntry, "ts">): Promise<void> {
    await this.appendLine("gateway", { ts: new Date().toISOString(), ...entry });
  }

  async logSystem(level: SystemLogEntry["level"], source: string, message: string, detail?: Record<string, unknown>): Promise<void> {
    await this.appendLine("system", { ts: new Date().toISOString(), level, source, message, detail: detail ?? null });
  }

  async listGatewayLogs(filters: GatewayLogFilters): Promise<LogPage<GatewayLogEntry>> {
    const rows = await this.readLogs<GatewayLogEntry>("gateway");
    // 最新记录在前，避免分页只看到历史日志。
    const filtered = rows.reverse().filter((row) => {
      if (filters.startTime && row.ts < filters.startTime) return false;
      if (filters.endTime && row.ts > filters.endTime) return false;
      if (filters.model && row.model !== filters.model) return false;
      if (filters.channel && row.channelName !== filters.channel) return false;
      if (filters.statusCode && String(row.statusCode) !== filters.statusCode) return false;
      if (filters.errorType && row.errorType !== filters.errorType) return false;
      return true;
    });
    return paginate(filtered, filters.limit, filters.offset);
  }

  async listSystemLogs(filters: SystemLogFilters): Promise<LogPage<SystemLogEntry>> {
    const rows = await this.readLogs<SystemLogEntry>("system");
    // 最新记录在前，避免分页只看到历史日志。
    const filtered = rows.reverse().filter((row) => {
      if (filters.level && row.level !== filters.level) return false;
      if (filters.source && row.source !== filters.source) return false;
      if (filters.startTime && row.ts < filters.startTime) return false;
      if (filters.endTime && row.ts > filters.endTime) return false;
      return true;
    });
    return paginate(filtered, filters.limit, filters.offset);
  }

  private async appendLine(kind: "gateway" | "system", data: Record<string, unknown>): Promise<void> {
    const file = this.fileFor(kind);
    const line = `${serializeSanitized(data)}\n`;
    // Serialize writes so concurrent requests do not interleave partial lines;
    // failures must never break the gateway path, so they are swallowed.
    const dirReady = this.dirReady ?? (this.dirReady = mkdir(this.logDir, { recursive: true }).then(() => undefined).catch(() => undefined));
    const queued = kind === "gateway" ? this.gatewayQueue : this.systemQueue;
    const next = queued.then(() => dirReady).then(() => appendFile(file, line, "utf8")).catch(() => undefined);
    if (kind === "gateway") this.gatewayQueue = next;
    else this.systemQueue = next;
    await next;
  }

  private fileFor(kind: "gateway" | "system"): string {
    const stamp = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `${kind}-${stamp}.jsonl`);
  }

  private async readLogs<T>(kind: "gateway" | "system"): Promise<T[]> {
    const files = (await readdir(this.logDir)).filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".jsonl"));
    const rows: T[] = [];
    for (const file of files.sort()) {
      try {
        const content = await readFile(join(this.logDir, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line) as T);
          } catch {
            // Skip malformed lines; the rest of the day's log is still readable.
          }
        }
      } catch {
        // Skip unreadable files.
      }
    }
    return rows;
  }
}

function paginate<T>(rows: T[], limit: number, offset: number): LogPage<T> {
  const total = rows.length;
  const items = rows.slice(offset, offset + limit);
  return { items, total, hasMore: offset + items.length < total };
}

function clampRetention(days: number): number {
  return Math.max(1, Math.min(90, Math.round(days)));
}
