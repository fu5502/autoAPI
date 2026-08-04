import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, PersistentMemoryStore } from "./memory-store.js";
import { createSecretBox } from "../security/secret-box.js";

describe("MemoryStore channel management", () => {
  it("updates channel settings, resets health, and disables removed model routes", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("memory-channel-test");
    const imported = await store.importProvider(
      {
        name: "Relay",
        baseUrl: "https://relay.example/v1",
        apiKey: "sk-original-key",
        protocol: "openai",
        models: ["gpt-a", "gpt-b"],
        priority: 10,
        weight: 100,
        tags: ["old"],
      },
      secrets.encrypt("sk-original-key"),
      "-key",
    );
    const channel = await store.applyProbeResult(imported.channel.id, {
      ok: true,
      protocol: "openai",
      models: ["gpt-a", "gpt-b"],
      latencyMs: 25,
      chatOk: true,
      streamOk: true,
      balance: 12,
      balanceCurrency: "USD",
      balanceStatus: "ok",
      error: null,
    }, 3);

    const updated = await store.updateChannel(channel.id, {
      name: "Relay Updated",
      baseUrl: "https://new-relay.example/v1",
      protocol: "openai",
      models: ["gpt-a"],
      priority: 20,
      weight: 50,
      minBalance: 1,
      tags: ["new"],
      enabled: true,
    });

    expect(updated).toMatchObject({ name: "Relay Updated", baseUrl: "https://new-relay.example/v1", status: "pending", balance: 12, balanceCurrency: "USD", models: ["gpt-a"] });
    expect(await store.listRoutingCandidates("gpt-b")).toHaveLength(0);
    expect(await store.listRoutingCandidates("gpt-a")).toHaveLength(1);
  });

  it("deletes channel routes and toggles disabled state", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("memory-channel-delete-test");
    const imported = await store.importProvider(
      { name: "Relay", baseUrl: "https://relay.example", apiKey: "sk-delete-key", protocol: "openai", models: ["gpt-a"], priority: 0, weight: 1, tags: [] },
      secrets.encrypt("sk-delete-key"),
      "-key",
    );
    const disabled = await store.setChannelEnabled(imported.channel.id, false);
    expect(disabled).toMatchObject({ enabled: false, status: "disabled" });
    expect(await store.deleteChannel(imported.channel.id)).toBe(true);
    expect(await store.getChannel(imported.channel.id)).toBeNull();
    expect(await store.listRoutingCandidates("gpt-a")).toHaveLength(0);
  });

  it("builds independent hourly health for each channel route", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("memory-pool-health-test");
    const first = await store.importProvider(
      { name: "Relay A", baseUrl: "https://relay-a.example", apiKey: "sk-a", protocol: "openai", models: ["gpt-shared"], priority: 10, weight: 1, tags: [] },
      secrets.encrypt("sk-a"),
      "sk-a",
    );
    const second = await store.importProvider(
      { name: "Relay B", baseUrl: "https://relay-b.example", apiKey: "sk-b", protocol: "openai", models: ["gpt-shared"], priority: 10, weight: 1, tags: [] },
      secrets.encrypt("sk-b"),
      "sk-b",
    );
    await store.applyProbeResult(first.channel.id, { ok: true, protocol: "openai", models: ["gpt-shared"], latencyMs: 20, chatOk: true, streamOk: true, balance: 10, balanceCurrency: "USD", balanceStatus: "ok", error: null }, 3);
    await store.applyProbeResult(second.channel.id, { ok: true, protocol: "openai", models: ["gpt-shared"], latencyMs: 20, chatOk: true, streamOk: true, balance: 10, balanceCurrency: "USD", balanceStatus: "ok", error: null }, 3);
    const now = Date.now();
    store.usage.push(
      usageEvent(first.channel.id, new Date(now - 10 * 60_000).toISOString(), 200),
      usageEvent(second.channel.id, new Date(now - 10 * 60_000).toISOString(), 503),
    );

    const pool = (await store.getPools()).find((item) => item.alias === "gpt-shared");
    expect(pool?.routes).toHaveLength(2);
    const routeA = pool?.routes.find((route) => route.channelId === first.channel.id);
    const routeB = pool?.routes.find((route) => route.channelId === second.channel.id);
    expect(routeA?.hourlyHealth).toHaveLength(24);
    expect(routeB?.hourlyHealth).toHaveLength(24);
    expect(routeA?.hourlyHealth.find((point) => point.requests === 1)).toMatchObject({ requests: 1, successfulRequests: 1, status: "available" });
    expect(routeB?.hourlyHealth.find((point) => point.requests === 1)).toMatchObject({ requests: 1, successfulRequests: 0, status: "abnormal" });
  });

  it("lists request logs with pagination, filters, channel details, and legacy-compatible fields", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("memory-request-log-test");
    const imported = await store.importProvider(
      { name: "Request Relay", baseUrl: "https://relay.example", apiKey: "sk-request-log", protocol: "openai", models: ["model-a", "model-b"], priority: 0, weight: 1, tags: [] },
      secrets.encrypt("sk-request-log"),
      "-log",
    );
    await store.recordUsage({
      requestId: "request-a",
      channelId: imported.channel.id,
      modelAlias: "model-a",
      upstreamModel: "upstream-a",
      clientName: "codex",
      requestKind: "responses",
      statusCode: 200,
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 140,
      errorType: null,
      retryCount: 0,
      streamed: true,
      endpoint: "/responses",
      sourceIp: "127.0.0.1",
    });
    await store.recordUsage({
      requestId: "request-b",
      channelId: imported.channel.id,
      modelAlias: "model-b",
      upstreamModel: "upstream-b",
      clientName: "claude-code",
      requestKind: "messages",
      statusCode: 429,
      promptTokens: 1,
      completionTokens: 0,
      latencyMs: 20,
      errorType: "rate_limited",
      retryCount: 1,
      streamed: false,
      sourceIp: "10.0.0.2",
    });

    const firstPage = await store.listRequestLogs({ limit: 1, offset: 0, window: "24h", localOnly: true });
    expect(firstPage).toMatchObject({ total: 1, hasMore: false });
    expect(firstPage.items[0]).toMatchObject({ requestId: "request-a", endpoint: "/responses", channelName: "Request Relay", sourceIp: "127.0.0.1", streamed: true });

    const secondPage = await store.listRequestLogs({ limit: 20, offset: 0, window: "24h", client: "claude", model: "model-b", channel: "Request Relay" });
    expect(secondPage).toMatchObject({ total: 1 });
    expect(secondPage.items[0]).toMatchObject({ requestId: "request-b", endpoint: "/messages", statusCode: 429, errorType: "rate_limited" });
  });

  it("persists channels, selected model routes, balances, and usage across store reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoapi-store-"));
    const statePath = join(directory, "state.json");
    try {
      const secrets = createSecretBox("persistent-channel-test");
      const first = await PersistentMemoryStore.fromFile(statePath);
      const imported = await first.importProvider(
        {
          name: "Persistent Relay",
          baseUrl: "https://relay.example/v1",
          apiKey: "sk-persistent-key",
          protocol: "openai",
          models: ["gpt-selected"],
          priority: 5,
          weight: 20,
          tags: ["local"],
        },
        secrets.encrypt("sk-persistent-key"),
        "-key",
      );
      await first.updateChannel(imported.channel.id, {
        name: imported.channel.name,
        baseUrl: imported.channel.baseUrl,
        protocol: imported.channel.protocol,
        models: imported.channel.models,
        priority: imported.channel.priority,
        weight: imported.channel.weight,
        minBalance: null,
        balance: 8.5,
        balanceCurrency: "USD",
        tags: imported.channel.tags,
      });
      await first.recordUsage({
        requestId: "persistent-request",
        channelId: imported.channel.id,
        modelAlias: "gpt-selected",
        upstreamModel: "gpt-selected",
        clientName: "test",
        requestKind: "chat",
        statusCode: 200,
        promptTokens: 3,
        completionTokens: 2,
        latencyMs: 41,
        errorType: null,
        retryCount: 0,
        streamed: false,
      });
      await first.close();

      const second = await PersistentMemoryStore.fromFile(statePath);
      expect(await second.listChannels()).toMatchObject([{ id: imported.channel.id, balance: 8.5, balanceCurrency: "USD", models: ["gpt-selected"] }]);
      expect(await second.listRoutingCandidates("gpt-selected")).toHaveLength(1);
      expect(await second.listRoutingCandidates("gpt-not-selected")).toHaveLength(0);
      expect((await second.getUsage("24h")).totalRequests).toBe(1);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function usageEvent(channelId: string, createdAt: string, statusCode: number) {
  return {
    requestId: `${channelId}-${createdAt}`,
    channelId,
    modelAlias: "gpt-shared",
    upstreamModel: "gpt-shared",
    clientName: "test",
    requestKind: "chat" as const,
    statusCode,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 100,
    errorType: statusCode >= 400 ? "upstream_5xx" : null,
    retryCount: 0,
    streamed: false,
    createdAt,
  };
}
