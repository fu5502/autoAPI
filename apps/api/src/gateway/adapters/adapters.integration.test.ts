import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../db/memory-store.js";
import type { GatewayRequest } from "../../domain/types.js";
import { createSecretBox } from "../../security/secret-box.js";
import { addHealthyChannel, readBody, startMockUpstream } from "../../test/test-helpers.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("protocol adapters", () => {
  it("sends Claude-native message requests with the mapped model and credential", async () => {
    let captured: { key?: string; model?: string } = {};
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (request) => {
        captured = {
          key: request.headers["x-api-key"] as string,
          model: (request.body as { model: string }).model,
        };
        return { id: "msg_test", type: "message", content: [{ type: "text", text: "claude-ok" }], usage: { input_tokens: 8, output_tokens: 3 } };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("claude-adapter-key");
    const channel = await addHealthyChannel(store, secrets, { name: "claude", baseUrl: mock.baseUrl, protocol: "claude", model: "claude-upstream" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "messages", model: "claude-local", stream: false, body: { model: "claude-local", max_tokens: 10, messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new ClaudeAdapter().execute(channel, `sk-test-${channel.name}`, request, "claude-upstream", 1_000);
    expect(captured).toEqual({ key: "sk-test-claude", model: "claude-upstream" });
    expect(await readBody(attempt.result.body)).toContain("claude-ok");
    expect(attempt).toMatchObject({ promptTokens: 8, completionTokens: 3 });
  });

  it("maps Gemini generateContent responses to OpenAI chat completions", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1beta/models/gemini-upstream:generateContent", async (request) => {
        expect(request.headers["x-goog-api-key"]).toBe("sk-test-gemini");
        return {
          candidates: [{ content: { role: "model", parts: [{ text: "gemini-ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
        };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("gemini-adapter-key");
    const channel = await addHealthyChannel(store, secrets, { name: "gemini", baseUrl: mock.baseUrl, protocol: "gemini", model: "gemini-upstream" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gemini-local", stream: false, body: { model: "gemini-local", messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new GeminiAdapter().execute(channel, "sk-test-gemini", request, "gemini-upstream", 1_000);
    const body = JSON.parse(await readBody(attempt.result.body));
    expect(body.choices[0].message.content).toBe("gemini-ok");
    expect(attempt).toMatchObject({ promptTokens: 7, completionTokens: 4 });
  });

  it("forwards Claude protocol headers without forwarding the gateway authorization", async () => {
    let captured: { version?: string; beta?: string; authorization?: string; apiKey?: string } = {};
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (request) => {
        captured = {
          version: request.headers["anthropic-version"] as string,
          beta: request.headers["anthropic-beta"] as string,
          authorization: request.headers.authorization as string,
          apiKey: request.headers["x-api-key"] as string,
        };
        return { id: "msg_headers", type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("claude-headers-key");
    const channel = await addHealthyChannel(store, secrets, { name: "claude-headers", baseUrl: mock.baseUrl, protocol: "claude", model: "claude-upstream" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "messages",
      model: "claude-local",
      stream: false,
      body: { model: "claude-local", max_tokens: 10, messages: [{ role: "user", content: "hello" }] },
      clientName: "claude-code",
      protocolHeaders: { "anthropic-version": "2024-10-22", "anthropic-beta": "prompt-caching-2024-07-31" },
    };

    await new ClaudeAdapter().execute(channel, `sk-test-${channel.name}`, request, "claude-upstream", 1_000);
    expect(captured).toEqual({
      version: "2024-10-22",
      beta: "prompt-caching-2024-07-31",
      authorization: undefined,
      apiKey: "sk-test-claude-headers",
    });
  });
});
