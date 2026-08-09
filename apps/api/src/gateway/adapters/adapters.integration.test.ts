import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../db/memory-store.js";
import type { GatewayRequest } from "../../domain/types.js";
import { createSecretBox } from "../../security/secret-box.js";
import { addHealthyChannel, readBody, startMockUpstream } from "../../test/test-helpers.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { OpenAiAdapter } from "./openai-adapter.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("protocol adapters", () => {
  it("reads OpenAI cached tokens from a non-streaming usage payload", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async () => ({
        id: "chatcmpl-cache",
        choices: [{ message: { role: "assistant", content: "cached-ok" } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 12 },
        },
      }));
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-cache-test");
    const channel = await addHealthyChannel(store, secrets, { name: "openai-cache", baseUrl: mock.baseUrl, model: "gpt-cache" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gpt-cache", stream: false, body: { model: "gpt-cache", messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-cache", request, "gpt-cache", 1_000);
    expect(attempt).toMatchObject({ promptTokens: 20, completionTokens: 4, cachedTokens: 12, firstByteLatencyMs: null });
  });

  it("records the first byte latency for streaming upstream responses", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"stream-ok\"}}]}\n\ndata: [DONE]\n\n");
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-stream-test");
    const channel = await addHealthyChannel(store, secrets, { name: "openai-stream", baseUrl: mock.baseUrl, model: "gpt-stream" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gpt-stream", stream: true, body: { model: "gpt-stream", stream: true, messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-stream", request, "gpt-stream", 1_000);
    expect(attempt.firstByteLatencyMs).toEqual(expect.any(Number));
    expect(attempt.firstByteLatencyMs).toBeGreaterThanOrEqual(0);
    expect(await readBody(attempt.result.body)).toContain("stream-ok");
  });

  it("collects OpenAI usage after a streaming response is consumed", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/chat/completions", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"stream-ok\"}}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":12}}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-stream-usage-test");
    const channel = await addHealthyChannel(store, secrets, { name: "openai-stream-usage", baseUrl: mock.baseUrl, model: "gpt-stream-usage" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gpt-stream-usage", stream: true, body: { model: "gpt-stream-usage", stream: true, messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-stream-usage", request, "gpt-stream-usage", 1_000);
    expect(attempt.streamUsage).toBeDefined();
    expect(await readBody(attempt.result.body)).toContain("stream-ok");
    await expect(attempt.streamUsage).resolves.toEqual({ promptTokens: 20, completionTokens: 4, cachedTokens: 12 });
  });

  it("maps streamed Chat tool calls into Codex Responses events", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/responses", async (_request, reply) => reply.code(404).send({ error: { message: "not supported" } }));
      app.post("/v1/chat/completions", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_stream\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-tool-stream-test");
    const channel = await addHealthyChannel(store, secrets, { name: "openai-tool-stream", baseUrl: mock.baseUrl, model: "gpt-tools" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "responses",
      model: "gpt-tools",
      stream: true,
      body: { model: "gpt-tools", input: "read a file", stream: true },
      clientName: "codex",
    };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-tools", request, "gpt-tools", 1_000);
    const output = await readBody(attempt.result.body);
    expect(output).toContain("response.output_item.added");
    expect(output).toContain("response.function_call_arguments.delta");
    expect(output).toContain("response.function_call_arguments.done");
    expect(output).toContain("response.output_item.done");
    expect(output).toContain("response.completed");
    expect(output).toContain("call_stream");
    expect(output).toContain("read_file");
  });

  it("collects Claude streaming usage events", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":8,\"cache_read_input_tokens\":5}}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"claude-stream\"}}\n\n",
          "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("claude-stream-usage-test");
    const channel = await addHealthyChannel(store, secrets, { name: "claude-stream-usage", baseUrl: mock.baseUrl, protocol: "claude", model: "claude-stream-usage" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "messages", model: "claude-stream-usage", stream: true, body: { model: "claude-stream-usage", stream: true, messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new ClaudeAdapter().execute(channel, "sk-claude-stream", request, "claude-stream-usage", 1_000);
    expect(await readBody(attempt.result.body)).toContain("claude-stream");
    await expect(attempt.streamUsage).resolves.toEqual({ promptTokens: 8, completionTokens: 3, cachedTokens: 5 });
  });

  it("sends Claude-native message requests with the mapped model and credential", async () => {
    let captured: { key?: string; model?: string } = {};
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (request) => {
        captured = {
          key: request.headers["x-api-key"] as string,
          model: (request.body as { model: string }).model,
        };
        return { id: "msg_test", type: "message", content: [{ type: "text", text: "claude-ok" }], usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 5 } };
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
    expect(attempt).toMatchObject({ promptTokens: 8, completionTokens: 3, cachedTokens: 5, firstByteLatencyMs: null });
  });

  it("bridges OpenAI chat requests through a Claude messages channel", async () => {
    let capturedBody: Record<string, unknown> = {};
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (request) => {
        capturedBody = request.body as Record<string, unknown>;
        return {
          id: "msg_chat_bridge",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "claude-chat-ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 },
        };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("claude-chat-bridge-test");
    const channel = await addHealthyChannel(store, secrets, { name: "claude-chat", baseUrl: mock.baseUrl, protocol: "claude", model: "claude-upstream" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "chat",
      model: "claude-local",
      stream: false,
      body: {
        model: "claude-local",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
        ],
        tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
        tool_choice: "auto",
      },
      clientName: "ai-sdk",
    };

    const attempt = await new ClaudeAdapter().execute(channel, "sk-chat", request, "claude-upstream", 1_000);
    expect(capturedBody).toMatchObject({
      model: "claude-upstream",
      max_tokens: 4096,
      stream: false,
      system: [{ type: "text", text: "be brief" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "read_file", description: "Read a file" }],
      tool_choice: { type: "auto" },
    });
    const body = JSON.parse(await readBody(attempt.result.body));
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("claude-chat-ok");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
    expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 2 });
    expect(attempt).toMatchObject({ promptTokens: 9, completionTokens: 4, cachedTokens: 2 });
  });

  it("streams OpenAI chat chunks from a Claude messages channel", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/messages", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_chat_stream\",\"usage\":{\"input_tokens\":8,\"cache_read_input_tokens\":5}}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"claude-chat-stream\"}}\n\n",
          "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("claude-chat-stream-test");
    const channel = await addHealthyChannel(store, secrets, { name: "claude-chat-stream", baseUrl: mock.baseUrl, protocol: "claude", model: "claude-upstream" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "chat",
      model: "claude-local",
      stream: true,
      body: { model: "claude-local", stream: true, messages: [{ role: "user", content: "hello" }] },
      clientName: "ai-sdk",
    };

    const attempt = await new ClaudeAdapter().execute(channel, "sk-chat", request, "claude-upstream", 1_000);
    const output = await readBody(attempt.result.body);
    expect(output).toContain("chat.completion.chunk");
    expect(output).toContain("claude-chat-stream");
    expect(output).toContain("finish_reason\":\"stop");
    expect(output).toContain("data: [DONE]");
    await expect(attempt.streamUsage).resolves.toEqual({ promptTokens: 8, completionTokens: 3, cachedTokens: 5 });
  });

  it("maps Gemini generateContent responses to OpenAI chat completions", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1beta/models/gemini-upstream:generateContent", async (request) => {
        expect(request.headers["x-goog-api-key"]).toBe("sk-test-gemini");
        return {
          candidates: [{ content: { role: "model", parts: [{ text: "gemini-ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11, cachedContentTokenCount: 2 },
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
    expect(attempt).toMatchObject({ promptTokens: 7, completionTokens: 4, cachedTokens: 2, firstByteLatencyMs: null });
  });

  it("collects Gemini streaming usage metadata", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1beta/models/gemini-stream:streamGenerateContent", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini-stream\"}]}}]}\n\n",
          "data: {\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":4,\"cachedContentTokenCount\":2}}\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("gemini-stream-usage-test");
    const channel = await addHealthyChannel(store, secrets, { name: "gemini-stream-usage", baseUrl: mock.baseUrl, protocol: "gemini", model: "gemini-stream" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gemini-stream", stream: true, body: { model: "gemini-stream", stream: true, messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new GeminiAdapter().execute(channel, "sk-gemini-stream", request, "gemini-stream", 1_000);
    expect(await readBody(attempt.result.body)).toContain("gemini-stream");
    await expect(attempt.streamUsage).resolves.toEqual({ promptTokens: 7, completionTokens: 4, cachedTokens: 2 });
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
