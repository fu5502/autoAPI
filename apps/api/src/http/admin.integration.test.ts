import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { MemoryRuntimeState } from "../runtime/runtime-state.js";
import { createSecretBox } from "../security/secret-box.js";
import { addHealthyChannel, startMockUpstream } from "../test/test-helpers.js";

const resources: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("admin channel management", () => {
  it("logs into the default admin account, records IPs, and changes the password", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-auth-legacy",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "AutoAPI@123456",
      GATEWAY_API_KEY: "gateway-auth-test",
      CREDENTIAL_ENCRYPTION_KEY: "auth-encryption-test",
      TRUST_PROXY: "true",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "100",
    });
    const app = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const bad = await app.app.inject({
      method: "POST",
      url: "/admin/auth/login",
      headers: { "x-forwarded-for": "203.0.113.10", "user-agent": "test-browser" },
      payload: { username: "admin", password: "bad-password" },
    });
    expect(bad.statusCode).toBe(401);

    const loggedIn = await app.app.inject({
      method: "POST",
      url: "/admin/auth/login",
      headers: { "x-forwarded-for": "203.0.113.10", "user-agent": "test-browser" },
      payload: { username: "admin", password: "AutoAPI@123456" },
    });
    expect(loggedIn.statusCode).toBe(200);
    const sessionHeaders = { authorization: `Bearer ${loggedIn.json().token}` };
    expect((await app.app.inject({ method: "GET", url: "/admin/auth/me", headers: sessionHeaders })).json()).toEqual({ username: "admin" });

    const changed = await app.app.inject({
      method: "POST",
      url: "/admin/security/password",
      headers: sessionHeaders,
      payload: { currentPassword: "AutoAPI@123456", newPassword: "NewAutoAPI@654321" },
    });
    expect(changed.statusCode).toBe(200);
    expect((await app.app.inject({ method: "GET", url: "/admin/auth/me", headers: sessionHeaders })).statusCode).toBe(401);
    const rotatedHeaders = { authorization: `Bearer ${changed.json().token}` };
    expect((await app.app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { username: "admin", password: "AutoAPI@123456" },
    })).statusCode).toBe(401);
    expect((await app.app.inject({
      method: "POST",
      url: "/admin/auth/login",
      headers: { "x-forwarded-for": "198.51.100.22" },
      payload: { username: "admin", password: "NewAutoAPI@654321" },
    })).statusCode).toBe(200);

    const history = await app.app.inject({ method: "GET", url: "/admin/security/login-history", headers: rotatedHeaders });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(4);
    expect(history.json()[0]).toMatchObject({ success: true, ip: "198.51.100.22" });
    expect(history.json()[3]).toMatchObject({ success: false, ip: "203.0.113.10" });
  });

  it("keeps only the latest ten login records", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-history-legacy",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "AutoAPI@123456",
      GATEWAY_API_KEY: "gateway-history-test",
      CREDENTIAL_ENCRYPTION_KEY: "history-encryption-test",
      TRUST_PROXY: "true",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "100",
    });
    const app = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    for (let index = 0; index < 12; index += 1) {
      await app.app.inject({ method: "POST", url: "/admin/auth/login", headers: { "x-forwarded-for": `192.0.2.${index + 1}` }, payload: { username: "admin", password: "wrong-password" } });
    }
    const history = await app.app.inject({ method: "GET", url: "/admin/security/login-history", headers: { authorization: "Bearer admin-history-legacy" } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(10);
    expect(history.json()[0].ip).toBe("192.0.2.12");
    expect(history.json().at(-1).ip).toBe("192.0.2.3");
  });

  it("ignores forwarded IP headers by default and rate limits repeated login attempts", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-rate-limit-legacy",
      ADMIN_PASSWORD: "AutoAPI@123456",
      GATEWAY_API_KEY: "gateway-rate-limit-test",
      CREDENTIAL_ENCRYPTION_KEY: "rate-limit-encryption-test",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "2",
      ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.app.inject({
        method: "POST",
        url: "/admin/auth/login",
        headers: { "x-forwarded-for": "203.0.113.50" },
        payload: { username: "admin", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.app.inject({
      method: "POST",
      url: "/admin/auth/login",
      headers: { "x-forwarded-for": "203.0.113.50" },
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { type: "rate_limited" } });

    const history = await app.app.inject({
      method: "GET",
      url: "/admin/security/login-history",
      headers: { authorization: "Bearer admin-rate-limit-legacy" },
    });
    expect(history.json()).toHaveLength(2);
    expect(history.json()[0].ip).not.toBe("203.0.113.50");
  });

  it("starts a demo-mode memory control plane without demo channels or usage", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-empty-test",
      GATEWAY_API_KEY: "gateway-empty-test",
      CREDENTIAL_ENCRYPTION_KEY: "empty-control-plane-key",
    });
    const app = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    expect(await app.store.listChannels()).toEqual([]);
    expect(await app.store.getPools()).toEqual([]);
    expect((await app.store.getUsage("24h")).totalRequests).toBe(0);
  });

  it("reports one-hour request health separately from the twenty-four-hour overview", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-hourly-status-test",
      GATEWAY_API_KEY: "gateway-hourly-status-test",
      CREDENTIAL_ENCRYPTION_KEY: "hourly-status-encryption-test",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      { name: "Hourly relay", baseUrl: "https://hourly.example/v1", apiKey: "sk-hourly-status", protocol: "openai", models: ["hourly-model"], priority: 0, weight: 100, tags: [] },
      secrets.encrypt("sk-hourly-status"),
      "atus",
    );
    await store.recordUsage({
      requestId: "hourly-status-request",
      channelId: imported.channel.id,
      modelAlias: "hourly-model",
      upstreamModel: "hourly-model",
      clientName: "test",
      requestKind: "chat",
      statusCode: 500,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 42,
      errorType: "upstream_5xx",
      retryCount: 0,
      streamed: false,
    });
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const response = await app.app.inject({ method: "GET", url: "/admin/status", headers: { authorization: "Bearer admin-hourly-status-test" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requests1h: 1,
      errorRate1h: 1,
      averageLatencyMs1h: 42,
      requests24h: 1,
      errorRate24h: 1,
    });
  });

  it("discovers models without creating a channel, then edits, disables, and deletes one", async () => {
    const upstream = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "gpt-admin-test" }] }));
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-channel-test",
      GATEWAY_API_KEY: "gateway-channel-test",
      CREDENTIAL_ENCRYPTION_KEY: "admin-channel-encryption",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      {
        name: "Relay",
        baseUrl: upstream.baseUrl,
        apiKey: "sk-admin-test-key",
        protocol: "openai",
        models: ["gpt-old"],
        priority: 1,
        weight: 10,
        tags: ["test"],
      },
      secrets.encrypt("sk-admin-test-key"),
      "-key",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const headers = { authorization: "Bearer admin-channel-test" };

    const discovered = await app.app.inject({
      method: "POST",
      url: "/admin/providers/models",
      headers,
      payload: { baseUrl: upstream.baseUrl, apiKey: "sk-discover-key", protocol: "openai", models: [] },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toMatchObject({ protocol: "openai", models: ["gpt-admin-test"], error: null });
    expect((await store.listChannels())).toHaveLength(1);

    const channelModels = await app.app.inject({
      method: "POST",
      url: `/admin/channels/${imported.channel.id}/models`,
      headers,
      payload: { baseUrl: upstream.baseUrl, protocol: "openai" },
    });
    expect(channelModels.statusCode).toBe(200);
    expect(channelModels.json()).toMatchObject({ protocol: "openai", models: ["gpt-admin-test"], error: null });

    const updated = await app.app.inject({
      method: "PUT",
      url: `/admin/channels/${imported.channel.id}`,
      headers,
      payload: {
        name: "Relay Updated",
        baseUrl: upstream.baseUrl,
        apiKey: "",
        protocol: "openai",
        models: ["gpt-admin-test"],
        priority: 20,
        weight: 50,
        minBalance: null,
        tags: ["updated"],
        enabled: true,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().channel).toMatchObject({ name: "Relay Updated", status: "pending", models: ["gpt-admin-test"] });

    const disabled = await app.app.inject({
      method: "PATCH",
      url: `/admin/channels/${imported.channel.id}/enabled`,
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().channel).toMatchObject({ enabled: false, status: "disabled" });

    const deleted = await app.app.inject({ method: "DELETE", url: `/admin/channels/${imported.channel.id}`, headers });
    expect(deleted.statusCode).toBe(204);
    expect(await store.getChannel(imported.channel.id)).toBeNull();
    expect(await store.listRoutingCandidates("gpt-old")).toHaveLength(0);

    const channels = await app.app.inject({ method: "GET", url: "/admin/channels", headers });
    expect(channels.statusCode).toBe(200);
    expect(channels.json()).toEqual([]);
    const pools = await app.app.inject({ method: "GET", url: "/admin/pools", headers });
    expect(pools.statusCode).toBe(200);
    expect(pools.json()).toEqual([]);
  });

  it("reorders channels through the admin API without resetting channel health", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-reorder-test",
      GATEWAY_API_KEY: "gateway-reorder-test",
      CREDENTIAL_ENCRYPTION_KEY: "reorder-encryption-test",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const first = await store.importProvider(
      { name: "Relay A", baseUrl: "https://relay-a.example", apiKey: "sk-admin-reorder-a", protocol: "openai", models: ["gpt-reorder"], priority: 1, weight: 11, tags: [] },
      secrets.encrypt("sk-admin-reorder-a"),
      "-a",
    );
    const second = await store.importProvider(
      { name: "Relay B", baseUrl: "https://relay-b.example", apiKey: "sk-admin-reorder-b", protocol: "openai", models: ["gpt-reorder"], priority: 2, weight: 22, tags: [] },
      secrets.encrypt("sk-admin-reorder-b"),
      "-b",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const response = await app.app.inject({
      method: "POST",
      url: "/admin/channels/reorder",
      headers: { authorization: "Bearer admin-reorder-test" },
      payload: { channelIds: [first.channel.id, second.channel.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().channels.map((channel: { id: string }) => channel.id)).toEqual([first.channel.id, second.channel.id]);
    expect(response.json().channels.map((channel: { priority: number }) => channel.priority)).toEqual([2, 1]);
    expect(await store.getChannel(second.channel.id)).toMatchObject({
      status: "pending",
      weight: 22,
      models: ["gpt-reorder"],
    });
  });

  it("creates, lists, authenticates, and safely deletes gateway keys", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-gateway-key-test",
      GATEWAY_API_KEY: "gateway-default-test",
      CREDENTIAL_ENCRYPTION_KEY: "gateway-key-encryption-test",
    });
    const app = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const adminHeaders = { authorization: "Bearer admin-gateway-key-test" };

    const initial = await app.app.inject({ method: "GET", url: "/admin/gateway-keys", headers: adminHeaders });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toHaveLength(1);
    expect(initial.json()[0]).not.toHaveProperty("keyHash");

    const created = await app.app.inject({
      method: "POST",
      url: "/admin/gateway-keys",
      headers: adminHeaders,
      payload: { name: "Codex desktop", key: "gateway-custom-client-key" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: "gateway-custom-client-key", gatewayKey: { name: "Codex desktop", keyLast4: "-key" } });
    expect(created.json().gatewayKey).not.toHaveProperty("keyHash");

    const modelsWithNewKey = await app.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer gateway-custom-client-key" },
    });
    expect(modelsWithNewKey.statusCode).toBe(200);

    const listed = await app.app.inject({ method: "GET", url: "/admin/gateway-keys", headers: adminHeaders });
    expect(listed.json()).toHaveLength(2);
    const newKeyId = created.json().gatewayKey.id as string;
    const removed = await app.app.inject({ method: "DELETE", url: `/admin/gateway-keys/${newKeyId}`, headers: adminHeaders });
    expect(removed.statusCode).toBe(204);

    const modelsWithRemovedKey = await app.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer gateway-custom-client-key" },
    });
    expect(modelsWithRemovedKey.statusCode).toBe(401);

    const remaining = (await app.app.inject({ method: "GET", url: "/admin/gateway-keys", headers: adminHeaders })).json();
    const rejected = await app.app.inject({ method: "DELETE", url: `/admin/gateway-keys/${remaining[0].id}`, headers: adminHeaders });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.message).toBe("At least one gateway key must remain");
  });

  it("runs a direct playground chat and records usage for the selected channel", async () => {
    const upstream = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (request) => {
        const body = request.body as { model?: string; messages?: Array<{ role: string; content: string }> };
        return {
          id: "chat-playground-test",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: `echo: ${body.messages?.at(-1)?.content ?? ""}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        };
      });
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-playground-test",
      GATEWAY_API_KEY: "gateway-playground-test",
      CREDENTIAL_ENCRYPTION_KEY: "playground-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      {
        name: "Playground relay",
        baseUrl: upstream.baseUrl,
        apiKey: "sk-playground-test",
        protocol: "openai",
        models: ["playground-model"],
        priority: 0,
        weight: 100,
        tags: [],
      },
      secrets.encrypt("sk-playground-test"),
      "-test",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const response = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers: { authorization: "Bearer admin-playground-test" },
      payload: {
        channelId: imported.channel.id,
        model: "playground-model",
        messages: [{ role: "user", content: "hello playground" }],
        temperature: 0.7,
        topP: 1,
        maxTokens: 32,
        stream: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "echo: hello playground", model: "playground-model", channelName: "Playground relay", usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 } });
    expect((await store.getUsage("24h")).totalRequests).toBe(1);
    expect((await store.getUsage("24h")).byClient).toMatchObject([{ name: "model-playground", requests: 1, errors: 0 }]);
    expect((await store.getChannel(imported.channel.id))?.status).toBe("healthy");
  });

  it("returns probed models without changing the channel model pool", async () => {
    const upstream = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "probe-model-a" }, { id: "probe-model-b" }] }));
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
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-probe-models-test",
      GATEWAY_API_KEY: "gateway-probe-models-test",
      CREDENTIAL_ENCRYPTION_KEY: "probe-models-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      {
        name: "Probe relay",
        baseUrl: upstream.baseUrl,
        apiKey: "sk-probe-models",
        protocol: "openai",
        models: ["selected-model"],
        priority: 0,
        weight: 100,
        tags: [],
      },
      secrets.encrypt("sk-probe-models"),
      "dels",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const response = await app.app.inject({
      method: "POST",
      url: `/admin/channels/${imported.channel.id}/probe`,
      headers: { authorization: "Bearer admin-probe-models-test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ probe: { ok: true, models: ["probe-model-a", "probe-model-b"] } });
    expect((await store.getChannel(imported.channel.id))?.models).toEqual(["selected-model"]);
  });

  it("supports streaming playground responses and aggregates the assistant text", async () => {
    const upstream = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          'data: {"choices":[{"delta":{"content":"stream "}}]}',
          'data: {"choices":[{"delta":{"content":"reply"}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"));
        return reply;
      });
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-playground-stream-test",
      GATEWAY_API_KEY: "gateway-playground-stream-test",
      CREDENTIAL_ENCRYPTION_KEY: "playground-stream-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      { name: "Streaming relay", baseUrl: upstream.baseUrl, apiKey: "sk-playground-stream", protocol: "openai", models: ["stream-model"], priority: 0, weight: 100, tags: [] },
      secrets.encrypt("sk-playground-stream"),
      "ream",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const response = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers: { authorization: "Bearer admin-playground-stream-test" },
      payload: { channelId: imported.channel.id, model: "stream-model", messages: [{ role: "user", content: "hello" }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json() as { sessionId: string; message: string; model: string };
    expect(result).toMatchObject({ message: "stream reply", model: "stream-model" });
    expect((await store.getUsage("24h")).totalRequests).toBe(1);
    const session = await store.getPlaygroundSession(result.sessionId);
    expect(session?.messages.at(-1)).toMatchObject({ content: "stream reply" });
  });

  it("streams playground deltas to an event-stream client and persists the completed message", async () => {
    const upstream = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.write('data: {"choices":[{"delta":{"content":"实时"}}]}\n\n');
        reply.raw.end('data: {"choices":[{"delta":{"content":"回复"}}]}\n\ndata: [DONE]\n\n');
        return reply;
      });
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-live-playground",
      GATEWAY_API_KEY: "gateway-live-playground",
      CREDENTIAL_ENCRYPTION_KEY: "live-playground-encryption-key",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      { name: "Live relay", baseUrl: upstream.baseUrl, apiKey: "sk-live-playground", protocol: "openai", models: ["live-model"], priority: 0, weight: 100, tags: [] },
      secrets.encrypt("sk-live-playground"),
      "ound",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const response = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers: { authorization: "Bearer admin-live-playground", accept: "text/event-stream" },
      payload: {
        sessionId: crypto.randomUUID(),
        channelId: imported.channel.id,
        model: "live-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: delta");
    expect(response.body).toContain("实时");
    expect(response.body).toContain("回复");
    expect(response.body).toContain("event: done");
    const doneData = response.body.split("event: done\ndata: ")[1]?.split("\n\n")[0];
    expect(doneData).toBeTruthy();
    const result = JSON.parse(doneData!) as { sessionId: string };
    const session = await store.getPlaygroundSession(result.sessionId);
    expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: "实时回复" });
  });

  it("records a playground upstream failure as an error usage event", async () => {
    const upstream = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (_request, reply) => reply.code(429).send({ error: { message: "rate limited" } }));
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-playground-error-test",
      GATEWAY_API_KEY: "gateway-playground-error-test",
      CREDENTIAL_ENCRYPTION_KEY: "playground-error-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      {
        name: "Error relay",
        baseUrl: upstream.baseUrl,
        apiKey: "sk-playground-error",
        protocol: "openai",
        models: ["error-model"],
        priority: 0,
        weight: 100,
        tags: [],
      },
      secrets.encrypt("sk-playground-error"),
      "rror",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const response = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers: { authorization: "Bearer admin-playground-error-test" },
      payload: { channelId: imported.channel.id, model: "error-model", messages: [{ role: "user", content: "test" }] },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({ type: "rate_limited" });
    const usage = await store.getUsage("24h");
    expect(usage.totalRequests).toBe(1);
    expect(usage.errorRate).toBe(1);
    expect(usage.byClient).toMatchObject([{ name: "model-playground", requests: 1, errors: 1 }]);
  });

  it("keeps one playground session while switching channel and model", async () => {
    const upstreamA = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async () => ({
        choices: [{ message: { content: "reply from model-a" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }));
    });
    const upstreamB = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async () => ({
        choices: [{ message: { content: "reply from model-b" } }],
        usage: { prompt_tokens: 4, completion_tokens: 5 },
      }));
    });
    resources.push(upstreamA.app, upstreamB.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-playground-switch-test",
      GATEWAY_API_KEY: "gateway-playground-switch-test",
      CREDENTIAL_ENCRYPTION_KEY: "playground-switch-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const channelA = await addHealthyChannel(store, secrets, { name: "relay-a", baseUrl: upstreamA.baseUrl, model: "model-a" });
    const channelB = await addHealthyChannel(store, secrets, { name: "relay-b", baseUrl: upstreamB.baseUrl, model: "model-b" });
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const headers = { authorization: "Bearer admin-playground-switch-test" };

    const first = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers,
      payload: {
        channelId: channelA.id,
        model: "model-a",
        messages: [{ role: "user", content: "first" }],
      },
    });
    expect(first.statusCode).toBe(200);
    const sessionId = first.json().sessionId as string;

    const second = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers,
      payload: {
        sessionId,
        channelId: channelB.id,
        model: "model-b",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply from model-a", model: "model-a", channelId: channelA.id, channelName: "relay-a", providerName: "relay-a" },
          { role: "user", content: "second" },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ sessionId, model: "model-b", channelId: channelB.id, channelName: "relay-b" });

    const loaded = await app.app.inject({ method: "GET", url: `/admin/playground/sessions/${sessionId}`, headers });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({
      id: sessionId,
      channelId: channelB.id,
      model: "model-b",
    });
    expect(loaded.json().messages.filter((message: { role: string }) => message.role === "assistant")).toMatchObject([
      { content: "reply from model-a", model: "model-a", channelId: channelA.id, channelName: "relay-a" },
      { content: "reply from model-b", model: "model-b", channelId: channelB.id, channelName: "relay-b" },
    ]);
  });

  it("persists playground sessions and restores their messages without affecting usage", async () => {
    const upstream = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (request) => {
        const body = request.body as { messages?: Array<{ content: string }> };
        return {
          choices: [{ message: { content: `reply: ${body.messages?.at(-1)?.content ?? ""}` } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        };
      });
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-playground-session-test",
      GATEWAY_API_KEY: "gateway-playground-session-test",
      CREDENTIAL_ENCRYPTION_KEY: "playground-session-encryption-test",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const imported = await store.importProvider(
      {
        name: "Session relay",
        baseUrl: upstream.baseUrl,
        apiKey: "sk-playground-session",
        protocol: "openai",
        models: ["session-model"],
        priority: 0,
        weight: 100,
        tags: [],
      },
      secrets.encrypt("sk-playground-session"),
      "ssion",
    );
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);
    const headers = { authorization: "Bearer admin-playground-session-test" };
    const first = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers,
      payload: {
        channelId: imported.channel.id,
        model: "session-model",
        messages: [{ role: "user", content: "first" }],
        maxTokens: 16,
      },
    });
    expect(first.statusCode).toBe(200);
    const sessionId = first.json().sessionId as string;
    const second = await app.app.inject({
      method: "POST",
      url: "/admin/playground/chat",
      headers,
      payload: {
        sessionId,
        channelId: imported.channel.id,
        model: "session-model",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply: first" },
          { role: "user", content: "second" },
        ],
        maxTokens: 16,
      },
    });
    expect(second.statusCode).toBe(200);
    const listed = await app.app.inject({ method: "GET", url: "/admin/playground/sessions", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject([{ id: sessionId, model: "session-model", messages: [{ content: "first" }, { content: "reply: first" }, { content: "second" }, { content: "reply: second" }] }]);
    const loaded = await app.app.inject({ method: "GET", url: `/admin/playground/sessions/${sessionId}`, headers });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().messages).toHaveLength(4);
    expect((await store.getUsage("24h")).totalRequests).toBe(2);
    const deleted = await app.app.inject({ method: "DELETE", url: `/admin/playground/sessions/${sessionId}`, headers });
    expect(deleted.statusCode).toBe(204);
    expect((await app.app.inject({ method: "GET", url: "/admin/playground/sessions", headers })).json()).toEqual([]);
  });

  it("reloads the file-backed demo store without clearing channels, routes, balances, or usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoapi-admin-persist-"));
    const config = loadConfig({
      NODE_ENV: "development",
      APP_MODE: "demo",
      DATA_DIR: directory,
      ADMIN_TOKEN: "admin-persist-test",
      GATEWAY_API_KEY: "gateway-persist-test",
      CREDENTIAL_ENCRYPTION_KEY: "persist-encryption-test",
    });
    const headers = { authorization: "Bearer admin-persist-test" };
    let first: Awaited<ReturnType<typeof buildApp>> | null = null;
    let second: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      first = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
      const created = await first.app.inject({
        method: "POST",
        url: "/admin/providers/import",
        headers,
        payload: {
          name: "Persistent relay",
          baseUrl: "https://persistent.example/v1",
          apiKey: "sk-persistent-test",
          protocol: "openai",
          models: ["persist-model"],
          priority: 3,
          weight: 20,
          tags: ["local"],
        },
      });
      expect(created.statusCode).toBe(201);
      const channelId = created.json().channel.id as string;
      const updated = await first.app.inject({
        method: "PUT",
        url: `/admin/channels/${channelId}`,
        headers,
        payload: {
          name: "Persistent relay",
          baseUrl: "https://persistent.example/v1",
          apiKey: "",
          protocol: "openai",
          models: ["persist-model"],
          priority: 3,
          weight: 20,
          minBalance: null,
          balance: 8.5,
          balanceCurrency: "USD",
          tags: ["local"],
          enabled: true,
        },
      });
      expect(updated.statusCode).toBe(200);
      await first.store.recordUsage({
        requestId: "persist-request",
        channelId,
        modelAlias: "persist-model",
        upstreamModel: "persist-model",
        clientName: "integration-test",
        requestKind: "chat",
        statusCode: 200,
        promptTokens: 4,
        completionTokens: 2,
        latencyMs: 31,
        errorType: null,
        retryCount: 0,
        streamed: false,
      });
      await first.store.savePlaygroundSession({
        id: "11111111-1111-4111-8111-111111111111",
        channelId,
        channelName: "Persistent relay",
        providerName: "Persistent relay",
        model: "persist-model",
        temperature: 0.7,
        topP: 1,
        maxTokens: 32,
        frequencyPenalty: 0,
        presencePenalty: 0,
        messages: [{ role: "user", content: "persisted playground", createdAt: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await first.app.close();
      first = null;

      second = await buildApp({ config, runtime: new MemoryRuntimeState(), startAgent: false });
      const channels = await second.app.inject({ method: "GET", url: "/admin/channels", headers });
      expect(channels.statusCode).toBe(200);
      expect(channels.json()).toMatchObject([{ id: channelId, models: ["persist-model"], balance: 8.5, balanceCurrency: "USD" }]);
      const pools = await second.app.inject({ method: "GET", url: "/admin/pools", headers });
      expect(pools.json()).toMatchObject([{ alias: "persist-model", channels: 1 }]);
      const usage = await second.app.inject({ method: "GET", url: "/admin/usage?window=24h", headers });
      expect(usage.json().totalRequests).toBe(1);
      const sessions = await second.app.inject({ method: "GET", url: "/admin/playground/sessions", headers });
      expect(sessions.json()).toMatchObject([{ id: "11111111-1111-4111-8111-111111111111", model: "persist-model", messages: [{ content: "persisted playground" }] }]);
    } finally {
      await first?.app.close();
      await second?.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes ordinary channel balances without running model probes", async () => {
    const upstream = await startMockUpstream((app) => {
      app.get("/api/user/self", async () => ({ balance: 0, currency: "USD" }));
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-balance-refresh-test",
      GATEWAY_API_KEY: "gateway-balance-refresh-test",
      CREDENTIAL_ENCRYPTION_KEY: "balance-refresh-encryption-test",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const channel = await addHealthyChannel(store, secrets, { name: "Balance relay", baseUrl: upstream.baseUrl, balance: 12 });
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const response = await app.app.inject({
      method: "POST",
      url: "/admin/channels/balances/refresh",
      headers: { authorization: "Bearer admin-balance-refresh-test" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { total: 1, refreshed: 1, unknown: 0, failed: 0 } });
    expect(await store.getChannel(channel.id)).toMatchObject({ balance: 0, balanceCurrency: "USD", balanceStatus: "exhausted" });
  });

  it("does not request balances for disabled channels", async () => {
    let requests = 0;
    const upstream = await startMockUpstream((app) => {
      app.get("/api/user/self", async () => {
        requests += 1;
        return { balance: 4, currency: "USD" };
      });
    });
    resources.push(upstream.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-disabled-balance-test",
      GATEWAY_API_KEY: "gateway-disabled-balance-test",
      CREDENTIAL_ENCRYPTION_KEY: "disabled-balance-encryption-test",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    const enabledChannel = await addHealthyChannel(store, secrets, { name: "Enabled relay", baseUrl: upstream.baseUrl, balance: 12 });
    const disabledChannel = await addHealthyChannel(store, secrets, { name: "Disabled relay", baseUrl: upstream.baseUrl, balance: 12 });
    await store.setChannelEnabled(disabledChannel.id, false);
    const app = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(app.app);

    const response = await app.app.inject({
      method: "POST",
      url: "/admin/channels/balances/refresh",
      headers: { authorization: "Bearer admin-disabled-balance-test" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { total: 1, refreshed: 1, unknown: 0, failed: 0 } });
    expect(requests).toBe(1);
    expect(await store.getChannel(enabledChannel.id)).toMatchObject({ balance: 4 });
    expect(await store.getChannel(disabledChannel.id)).toMatchObject({ balance: 12, enabled: false, status: "disabled" });
  });
});
