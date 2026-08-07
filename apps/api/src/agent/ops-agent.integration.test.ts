import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory-store.js";
import { AdapterRegistry } from "../gateway/adapter.js";
import { ClaudeAdapter } from "../gateway/adapters/claude-adapter.js";
import { GeminiAdapter } from "../gateway/adapters/gemini-adapter.js";
import { OpenAiAdapter } from "../gateway/adapters/openai-adapter.js";
import { createSecretBox } from "../security/secret-box.js";
import { startMockUpstream } from "../test/test-helpers.js";
import { isOfficialApiKey, OpsAgent } from "./ops-agent.js";

let server: FastifyInstance | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("operations agent", () => {
  it("only accepts official-looking keys and imports a candidate without probing", async () => {
    let modelsChecks = 0;
    let chatChecks = 0;
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => {
        modelsChecks += 1;
        return { object: "list", data: [{ id: "gpt-import-test" }] };
      });
      app.post("/v1/chat/completions", async (request, reply) => {
        chatChecks += 1;
        const body = request.body as { stream?: boolean };
        if (body.stream) {
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
          return reply;
        }
        return reply.send({ choices: [{ message: { content: "ok" } }], usage: {} });
      });
    });
    server = mock.app;
    const store = new MemoryStore();
    const secrets = createSecretBox("channel-import-test-key");
    const agent = new OpsAgent({
      store,
      secrets,
      registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
      timeoutMs: 1_000,
      failureThreshold: 3,
      intervalMs: 60_000,
    });

    expect(isOfficialApiKey("sk-valid-import-key")).toBe(true);
    expect(isOfficialApiKey("eyJhbGciOiJIUzI1NiJ9.payload.signature")).toBe(false);
    expect(isOfficialApiKey("access_token_value")).toBe(false);

    const preview = await agent.prepareChannelImport({
      siteId: 7,
      siteName: "Import site",
      baseUrl: `${mock.baseUrl}/`,
      apiKey: "sk-valid-import-key",
      protocol: "openai",
    });
    expect(preview).toMatchObject({ siteName: "Import site", baseUrl: mock.baseUrl, models: [], keyLast4: "-key", validation: { status: "not_probed" } });
    expect(JSON.stringify(preview)).not.toContain("sk-valid-import-key");

    const imported = await agent.confirmChannelImport({
      siteId: 7,
      candidateId: preview.candidateId,
      name: "Imported site",
      models: ["gpt-import-test"],
      priority: 5,
      weight: 100,
      tags: ["签到站点"],
    });
    expect(imported.channel.status).toBe("pending");
    expect(imported.channel.keyCiphertext).not.toContain("sk-valid-import-key");
    expect(imported.channel.models).toEqual([]);
    expect(await store.listRoutingCandidates("gpt-import-test")).toHaveLength(0);
    expect(modelsChecks).toBe(0);
    expect(chatChecks).toBe(0);

    await store.updateChannel(imported.channel.id, {
      name: imported.channel.name,
      baseUrl: imported.channel.baseUrl,
      protocol: imported.channel.protocol,
      models: ["existing-model"],
      priority: imported.channel.priority,
      weight: imported.channel.weight,
      minBalance: imported.channel.minBalance,
      tags: imported.channel.tags,
      enabled: imported.channel.enabled,
    });

    const reimportPreview = await agent.prepareChannelImport({
      siteId: 7,
      siteName: "Import site",
      baseUrl: `${mock.baseUrl}/v1/`,
      apiKey: "sk-rotated-import-key",
      protocol: "openai",
    });
    expect(reimportPreview.matchedChannel).toMatchObject({ id: imported.channel.id, name: "Imported site", baseUrl: mock.baseUrl });

    const updated = await agent.confirmChannelImport({
      siteId: 7,
      candidateId: reimportPreview.candidateId,
      name: "Reimported site",
      models: [],
      priority: 7,
      weight: 80,
      tags: ["签到站点", "重新导入"],
    });
    expect(updated.action).toBe("updated");
    expect(updated.channel.id).toBe(imported.channel.id);
    expect(updated.channel.name).toBe("Reimported site");
    expect(updated.channel.baseUrl).toBe(`${mock.baseUrl}/v1`);
    expect(updated.channel.models).toEqual(["existing-model"]);
    expect(secrets.decrypt(updated.channel.keyCiphertext)).toBe("sk-rotated-import-key");
    expect(await store.listChannels()).toHaveLength(1);
  });

  it("accepts a complete non-sk key returned by an official provider API", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("channel-import-custom-prefix-test");
    const agent = new OpsAgent({
      store,
      secrets,
      registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
      timeoutMs: 1_000,
      failureThreshold: 3,
      intervalMs: 60_000,
    });

    const preview = await agent.prepareChannelImport({
      siteId: 12,
      siteName: "Custom prefix site",
      keyName: "Official key",
      baseUrl: "https://custom-prefix.example",
      apiKey: "ak_live_complete_provider_key_12345",
      protocol: "new-api",
    });

    expect(preview.keyName).toBe("Official key");
    const imported = await agent.confirmChannelImport({
      siteId: 12,
      candidateId: preview.candidateId,
      name: "Custom prefix site",
      models: [],
      priority: 0,
      weight: 100,
      tags: [],
    });
    expect(secrets.decrypt(imported.channel.keyCiphertext)).toBe("ak_live_complete_provider_key_12345");
  });

  it("keeps multiple validated keys selectable and imports only the selected key", async () => {
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "gpt-multi-key-test" }] }));
      app.post("/v1/chat/completions", async (request, reply) => {
        const body = request.body as { stream?: boolean };
        if (body.stream) {
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
          return reply;
        }
        return reply.send({ choices: [{ message: { content: "ok" } }], usage: {} });
      });
    });
    server = mock.app;
    const store = new MemoryStore();
    const secrets = createSecretBox("multi-key-import-test-key");
    const agent = new OpsAgent({
      store,
      secrets,
      registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
      timeoutMs: 1_000,
      failureThreshold: 3,
      intervalMs: 60_000,
    });

    const first = await agent.prepareChannelImport({
      siteId: 8,
      siteName: "Multi-key site",
      keyName: "Primary",
      baseUrl: mock.baseUrl,
      apiKey: "sk-primary-one",
      protocol: "openai",
    });
    const second = await agent.prepareChannelImport({
      siteId: 8,
      siteName: "Multi-key site",
      keyName: "Backup",
      baseUrl: mock.baseUrl,
      apiKey: "sk-backup-two",
      protocol: "openai",
    });

    expect(first.candidateId).not.toBe(second.candidateId);
    expect(first.keyName).toBe("Primary");
    expect(second.keyName).toBe("Backup");
    expect(first.keyLast4).toBe("-one");
    expect(second.keyLast4).toBe("-two");
    expect(JSON.stringify({ first, second })).not.toContain("sk-primary-one");
    expect(JSON.stringify({ first, second })).not.toContain("sk-backup-two");

    const imported = await agent.confirmChannelImport({
      siteId: 8,
      candidateId: second.candidateId,
      name: "Selected backup",
      models: second.models,
      priority: 0,
      weight: 100,
      tags: [],
    });
    expect(secrets.decrypt(imported.channel.keyCiphertext)).toBe("sk-backup-two");
    expect(await store.listChannels()).toHaveLength(1);
    expect(imported.channel.status).toBe("pending");
    expect(imported.channel.models).toEqual([]);
  });

  it("imports successfully when the upstream would reject probe requests", async () => {
    let requestCount = 0;
    const mock = await startMockUpstream((app) => {
      app.all("/v1/*", async (_request, reply) => {
        requestCount += 1;
        return reply.code(503).send({ error: { message: "system cpu overloaded (current: 91.1%, threshold: 90%)" } });
      });
    });
    server = mock.app;
    const agent = new OpsAgent({
      store: new MemoryStore(),
      secrets: createSecretBox("overload-import-test-key"),
      registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
      timeoutMs: 1_000,
      failureThreshold: 3,
      intervalMs: 60_000,
    });

    const preview = await agent.prepareChannelImport({
      siteId: 9,
      siteName: "Overloaded site",
      baseUrl: mock.baseUrl,
      apiKey: "sk-overload-test",
      protocol: "openai",
    });
    expect(preview.validation.status).toBe("not_probed");
    expect(requestCount).toBe(0);
  });

  it("adds a channel without probing, then keeps manual probes from changing selected models", async () => {
    let chatChecks = 0;
    let streamChecks = 0;
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "gpt-agent-test" }] }));
      app.post("/v1/chat/completions", async (request, reply) => {
        const body = request.body as { stream?: boolean };
        if (body.stream) {
          streamChecks += 1;
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
          return reply;
        }
        chatChecks += 1;
        return reply.send({ choices: [{ message: { content: "ok" } }], usage: {} });
      });
    });
    server = mock.app;
    const store = new MemoryStore();
    const secrets = createSecretBox("ops-agent-test-key");
    const agent = new OpsAgent({
      store,
      secrets,
      registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
      timeoutMs: 1_000,
      failureThreshold: 3,
      intervalMs: 60_000,
    });

    const imported = await agent.onboard({
      name: "Detected relay",
      baseUrl: mock.baseUrl,
      apiKey: "sk-detected-secret",
      protocol: "auto",
      models: [],
      priority: 10,
      weight: 100,
      tags: ["auto"],
    });

    expect(imported.channel.status).toBe("pending");
    expect(imported.channel.protocol).toBe("auto");
    expect(imported.channel.keyCiphertext).not.toContain("sk-detected-secret");
    expect((await store.listRoutingCandidates("gpt-agent-test"))).toHaveLength(0);
    expect(chatChecks).toBe(0);
    expect(streamChecks).toBe(0);

    const probe = await agent.probeChannel(imported.channel.id);
    expect(probe).toMatchObject({ ok: true, protocol: "openai", chatOk: true, streamOk: true, balanceStatus: "unknown" });
    expect((await store.getChannel(imported.channel.id))?.status).toBe("healthy");
    expect((await store.getChannel(imported.channel.id))?.models).toEqual([]);
    expect((await store.listRoutingCandidates("gpt-agent-test"))).toHaveLength(0);
    expect(chatChecks).toBe(1);
    expect(streamChecks).toBe(1);
  });

  it("isolates a channel after the configured number of failed checks and restores it after recovery", async () => {
    const store = new MemoryStore();
    const secrets = createSecretBox("ops-agent-failure-key");
    const imported = await store.importProvider(
      { name: "Offline", baseUrl: "http://127.0.0.1:1", apiKey: "sk-offline", protocol: "openai", models: ["test"], priority: 0, weight: 100, tags: [] },
      secrets.encrypt("sk-offline"),
      "line",
    );
    const failure = {
      ok: false,
      protocol: "openai" as const,
      models: ["test"],
      latencyMs: 10,
      chatOk: false,
      streamOk: false,
      balance: null,
      balanceCurrency: null,
      balanceStatus: "unknown" as const,
      error: "connection_error",
    };
    await store.applyProbeResult(imported.channel.id, failure, 2);
    expect((await store.getChannel(imported.channel.id))?.status).toBe("degraded");
    await store.applyProbeResult(imported.channel.id, failure, 2);
    expect((await store.getChannel(imported.channel.id))?.status).toBe("isolated");
    await store.applyProbeResult(imported.channel.id, { ...failure, ok: true, chatOk: true, streamOk: true, error: null }, 2);
    expect((await store.getChannel(imported.channel.id))?.status).toBe("healthy");
  });
});
