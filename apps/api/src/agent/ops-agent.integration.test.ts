import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory-store.js";
import { AdapterRegistry } from "../gateway/adapter.js";
import { ClaudeAdapter } from "../gateway/adapters/claude-adapter.js";
import { GeminiAdapter } from "../gateway/adapters/gemini-adapter.js";
import { OpenAiAdapter } from "../gateway/adapters/openai-adapter.js";
import { createSecretBox } from "../security/secret-box.js";
import { startMockUpstream } from "../test/test-helpers.js";
import { OpsAgent } from "./ops-agent.js";

let server: FastifyInstance | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("operations agent", () => {
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
