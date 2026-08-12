import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticLogger, sanitizeMessage, serializeSanitized } from "./diagnostic-log.js";

async function gatewayFileContent(dir: string): Promise<string> {
  const names = (await readdir(join(dir, "logs"))).filter((name) => name.startsWith("gateway-"));
  expect(names.length).toBe(1);
  return readFile(join(dir, "logs", names[0]!), "utf8");
}

describe("DiagnosticLogger", () => {
  it("writes sanitized gateway and system log lines that survive a reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autoapi-diagnostic-"));
    try {
      const logger = new DiagnosticLogger(dir);
      await logger.init();
      await logger.logGateway({
        requestId: "req-1",
        kind: "responses",
        model: "mimo-v2.5",
        channelId: "ch-1",
        channelName: "opencode go",
        upstreamModel: "mimo-v2.5",
        statusCode: 400,
        errorType: "upstream_rejected",
        errorDetail: null,
        upstreamBody: '{"error":{"message":"Error from provider"}}',
        requestBody: '{"model":"mimo-v2.5","apiKey":"sk-super-secret-key"}',
        retryCount: 2,
        retryTrace: [{ channelName: "opencode go", statusCode: 400, errorType: "upstream_rejected", latencyMs: 100 }],
        latencyMs: 150,
        streamed: true,
        clientName: "codex",
        endpoint: "/responses",
        promptTokens: 10,
        completionTokens: 0,
      });
      await logger.logSystem("warn", "probe", "渠道探测 失败", { channelName: "relay", error: "timeout" });

      const raw = await gatewayFileContent(dir);
      expect(raw).toContain("sk-[redacted]");
      expect(raw).not.toContain("sk-super-secret-key");
      expect(raw).toContain("Error from provider");

      const reopened = new DiagnosticLogger(dir);
      const gateway = await reopened.listGatewayLogs({ limit: 50, offset: 0 });
      expect(gateway.total).toBe(1);
      expect(gateway.items[0]).toMatchObject({ requestId: "req-1", statusCode: 400, model: "mimo-v2.5" });

      const system = await reopened.listSystemLogs({ limit: 50, offset: 0 });
      expect(system.total).toBe(1);
      expect(system.items[0]).toMatchObject({ level: "warn", source: "probe" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters gateway logs by model, channel, status and errorType", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autoapi-diagnostic-filter-"));
    try {
      const logger = new DiagnosticLogger(dir);
      await logger.logGateway({
        requestId: "a", kind: "chat", model: "deepseek-v4-flash", channelId: "c1", channelName: "relay-a",
        upstreamModel: "deepseek-v4-flash", statusCode: 200, errorType: null, errorDetail: null,
        upstreamBody: null, requestBody: null, retryCount: 0, retryTrace: [], latencyMs: 10,
        streamed: false, clientName: "codex", endpoint: null, promptTokens: 1, completionTokens: 1,
      });
      await logger.logGateway({
        requestId: "b", kind: "responses", model: "mimo-v2.5", channelId: "c2", channelName: "opencode go",
        upstreamModel: "mimo-v2.5", statusCode: 400, errorType: "upstream_rejected", errorDetail: null,
        upstreamBody: "err", requestBody: "{}", retryCount: 1, retryTrace: [], latencyMs: 20,
        streamed: true, clientName: "codex", endpoint: "/responses", promptTokens: 5, completionTokens: 0,
      });

      expect((await logger.listGatewayLogs({ limit: 10, offset: 0, model: "mimo-v2.5" })).total).toBe(1);
      expect((await logger.listGatewayLogs({ limit: 10, offset: 0, channel: "opencode go" })).total).toBe(1);
      expect((await logger.listGatewayLogs({ limit: 10, offset: 0, statusCode: "400" })).total).toBe(1);
      expect((await logger.listGatewayLogs({ limit: 10, offset: 0, errorType: "upstream_rejected" })).total).toBe(1);
      const page = await logger.listGatewayLogs({ limit: 1, offset: 0 });
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans up by retention days and clears all files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autoapi-diagnostic-clean-"));
    try {
      const logger = new DiagnosticLogger(dir, 1);
      await logger.logGateway({
        requestId: "c1", kind: "chat", model: "m", channelId: "c", channelName: "relay",
        upstreamModel: "m", statusCode: 200, errorType: null, errorDetail: null,
        upstreamBody: null, requestBody: null, retryCount: 0, retryTrace: [], latencyMs: 1,
        streamed: false, clientName: "codex", endpoint: null, promptTokens: 1, completionTokens: 1,
      });
      expect(logger.getRetentionDays()).toBe(1);

      // Write a log line whose file name is exactly 8 days old.
      const { readdir } = await import("node:fs/promises");
      const names = (await readdir(join(dir, "logs"))).filter((name) => name.startsWith("gateway-"));
      const oldStamp = new Date();
      oldStamp.setDate(oldStamp.getDate() - 8);
      const oldFile = join(dir, "logs", `gateway-${oldStamp.toISOString().slice(0, 10)}.jsonl`);
      const { appendFile } = await import("node:fs/promises");
      await appendFile(oldFile, '{"requestId":"old"}\n', "utf8");
      void names;

      const removed = await logger.cleanup();
      expect(removed).toBe(1);
      const remaining = (await readdir(join(dir, "logs"))).filter((name) => name.startsWith("gateway-"));
      expect(remaining).toHaveLength(1);

      const cleared = await logger.clearAll();
      expect(cleared).toBe(1);
      expect((await readdir(join(dir, "logs"))).filter((name) => name.startsWith("gateway-"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeMessage / serializeSanitized", () => {
  it("redacts bearer tokens, sk- keys and api-key fields", () => {
    expect(sanitizeMessage("Bearer sk-abcdef1234567890 test")).toContain("Bearer [redacted]");
    expect(sanitizeMessage("sk-abcdef1234567890")).toBe("sk-[redacted]");
    expect(sanitizeMessage("apiKey=sk-abcdef1234567890")).toContain("apiKey=[redacted]");
  });

  it("redacts sensitive keys and sk- values while keeping numeric tokens", () => {
    const out = serializeSanitized({
      model: "mimo-v2.5",
      auth: { apiKey: "sk-long-secret-value" },
      promptTokens: 3,
      completionTokens: 1,
    });
    expect(out).toContain('"apiKey":"[redacted]"');
    expect(out).not.toContain("sk-long-secret-value");
    expect(out).toContain('"promptTokens":3');
    expect(out).toContain('"completionTokens":1');
  });

  it("truncates oversized entries with a marker", () => {
    const out = serializeSanitized("y".repeat(25_000));
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(20_100);
  });
});
