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
  it("tries the next probe variant after a chat probe 500", async () => {
    let responsesCalls = 0;
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "gpt-probe-500" }] }));
      app.post("/v1/chat/completions", async (_request, reply) => {
        return reply.code(500).send({ header: { code: 10910, message: "code=1001" } });
      });
      app.post("/v1/responses", async () => {
        responsesCalls += 1;
        return { object: "response", output_text: "probe-ok" };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-probe-500-test");
    const channel = await addHealthyChannel(store, secrets, { name: "probe-500", baseUrl: mock.baseUrl, model: "gpt-probe-500" });

    const result = await new OpenAiAdapter().probe(channel, "sk-probe-500", 1_000);

    expect(result.ok).toBe(true);
    expect(result.probeReply).toBe("probe-ok");
    expect(responsesCalls).toBe(1);
  });

  it("prefers a streaming chat probe when the relay rejects non-stream probes", async () => {
    let streamCalls = 0;
    let nonStreamCalls = 0;
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => ({ object: "list", data: [{ id: "grok-probe" }] }));
      app.post("/v1/chat/completions", async (request, reply) => {
        const body = request.body as { stream?: boolean } | null;
        if (body?.stream) {
          streamCalls += 1;
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.end([
            "data: {\"choices\":[{\"delta\":{\"content\":\"stream-probe-ok\"}}]}\n\n",
            "data: [DONE]\n\n",
          ].join(""));
          return reply;
        }
        nonStreamCalls += 1;
        return reply.code(500).send({ header: { code: 10910, message: "code=1001" } });
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-stream-probe-test");
    const channel = await addHealthyChannel(store, secrets, { name: "stream-probe", baseUrl: mock.baseUrl, model: "grok-probe" });

    const result = await new OpenAiAdapter().probe(channel, "sk-grok", 1_000);

    expect(result.ok).toBe(true);
    expect(result.probeReply).toBe("stream-probe-ok");
    expect(streamCalls).toBe(1);
    expect(nonStreamCalls).toBe(0);
  });

  it("probes with a configured model before fetching the model list", async () => {
    const order: string[] = [];
    const mock = await startMockUpstream((app) => {
      app.get("/v1/models", async () => {
        order.push("models");
        return { object: "list", data: [{ id: "grok-4.5" }, { id: "grok-other" }] };
      });
      app.post("/v1/chat/completions", async (_request, reply) => {
        order.push("chat");
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"ordered-probe-ok\"}}]}\n\ndata: [DONE]\n\n");
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-probe-order-test");
    const channel = await addHealthyChannel(store, secrets, { name: "probe-order", baseUrl: mock.baseUrl, model: "grok-4.5" });

    const result = await new OpenAiAdapter().probe(channel, "sk-probe-order", 1_000);

    expect(result.ok).toBe(true);
    expect(result.probeReply).toBe("ordered-probe-ok");
    expect(order).toEqual(["chat", "models"]);
  });

  it("prefers a streaming Gemini probe when the relay rejects non-stream probes", async () => {
    let streamCalls = 0;
    let nonStreamCalls = 0;
    const mock = await startMockUpstream((app) => {
      app.post("/v1beta/models/*", async (request, reply) => {
        if (request.url.includes("streamGenerateContent")) {
          streamCalls += 1;
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.end([
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini-stream-probe-ok\"}]}}]}\n\n",
          ].join(""));
          return reply;
        }
        nonStreamCalls += 1;
        return { header: { code: 10910, message: "code=1001" } };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("gemini-stream-probe-test");
    const channel = await addHealthyChannel(store, secrets, { name: "gemini-stream-probe", baseUrl: mock.baseUrl, protocol: "gemini", model: "grok-4.5" });

    const result = await new GeminiAdapter().probe(channel, "sk-gemini-probe", 1_000);

    expect(result.ok).toBe(true);
    expect(result.probeReply).toBe("gemini-stream-probe-ok");
    expect(streamCalls).toBe(1);
    expect(nonStreamCalls).toBe(0);
  });

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

  it("sanitizes Codex Responses tools before forwarding upstream (mimo-v2.5)", async () => {
    const model = "mimo-v2.5";
    let captured: { tools?: unknown[]; turn_id?: string; session_id?: string; thread_id?: string; prompt_cache_key?: string } = {};
    const mock = await startMockUpstream((app) => {
      app.post("/v1/responses", async (request) => {
        captured = request.body as { tools?: unknown[]; turn_id?: string; session_id?: string; thread_id?: string; prompt_cache_key?: string };
        return {
          id: "resp_sanitize",
          object: "response",
          status: "completed",
          model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "sanitize-ok", annotations: [] }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-sanitize-tools-test");
    const channel = await addHealthyChannel(store, secrets, { name: `sanitize-${model}`, baseUrl: mock.baseUrl, model });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "responses",
      model,
      stream: false,
      body: {
        model,
        input: "hello",
        tools: [
          {
            type: "function",
            name: "shell_command",
            description: "Run a shell command",
            strict: true,
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
          },
          { type: "custom", name: "apply_patch", description: "Edit files", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
          { type: "tool_search", execution: "client", description: "Tool discovery" },
          { type: "web_search", external_web_access: false, search_content_types: ["text", "image"] },
        ],
        turn_id: "turn_1",
        session_id: "sess_1",
        thread_id: "thread_1",
        prompt_cache_key: "cache_1",
        client_metadata: { x: 1 },
        instructions: "Be concise",
        stream: false,
      },
      clientName: "codex",
    };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-sanitize", request, model, 1_000);

    expect(captured.tools).toHaveLength(1);
    expect(captured.tools?.[0]).not.toHaveProperty("strict");
    expect(captured.tools?.[0]).toMatchObject({ type: "function", name: "shell_command" });
    expect(captured.turn_id).toBeUndefined();
    expect(captured.session_id).toBeUndefined();
    expect(captured.thread_id).toBeUndefined();
    expect(captured.prompt_cache_key).toBeUndefined();
    expect(JSON.parse(await readBody(attempt.result.body))).toMatchObject({ object: "response", model });
  });

  it("normalizes a non-compliant Responses stream into full events (mimo-v2.5)", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/responses", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          ": keep-alive\n\n",
          "event: response.output_text.delta\ndata: {\"id\":\"gen_abc\",\"type\":\"response.output_text.delta\",\"delta\":\"Hel\",\"response\":{\"id\":\"gen_abc\",\"model\":\"mimo-v2.5\"}}\n\n",
          "event: response.output_text.delta\ndata: {\"id\":\"gen_abc\",\"type\":\"response.output_text.delta\",\"delta\":\"lo\",\"response\":{\"id\":\"gen_abc\",\"model\":\"mimo-v2.5\"}}\n\n",
          "event: response.completed\ndata: {\"id\":\"gen_abc\",\"type\":\"response.completed\",\"response\":{\"id\":\"gen_abc\",\"model\":\"mimo-v2.5\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-normalize-stream-test");
    const channel = await addHealthyChannel(store, secrets, { name: "normalize-mimo", baseUrl: mock.baseUrl, model: "mimo-v2.5" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "responses",
      model: "mimo-v2.5",
      stream: true,
      body: { model: "mimo-v2.5", input: "hello", stream: true },
      clientName: "codex",
    };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-normalize", request, "mimo-v2.5", 1_000);
    const output = await readBody(attempt.result.body);

    expect(output).toContain('"type":"response.created"');
    expect(output).toContain('"type":"response.in_progress"');
    expect(output).toContain('"type":"response.output_item.added"');
    expect(output).toContain('"type":"response.content_part.added"');
    expect(output).toContain('"type":"response.output_text.done"');
    expect(output).toContain('"type":"response.content_part.done"');
    expect(output).toContain('"type":"response.output_item.done"');
    expect(output).toContain('"type":"response.completed"');
    // synthesized item_id / output_index on deltas
    expect(output).toContain('"item_id":"msg_gen_abc"');
    expect(output).toContain('"output_index":0');
  });

  it("collapses multi-turn history into one message after repeated Responses 400s (mimo-v2.5)", async () => {
    const received: Array<{ input?: unknown[] }> = [];
    let responsesCalls = 0;
    const mock = await startMockUpstream((app) => {
      app.post("/v1/responses", async (request, reply) => {
        responsesCalls += 1;
        received.push(request.body as { input?: unknown[] });
        if (responsesCalls < 3) {
          return reply.code(400).send({ error: { message: "Provider returned error" } });
        }
        return {
          id: "resp_collapse",
          object: "response",
          status: "completed",
          model: "mimo-v2.5",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "collapse-ok", annotations: [] }] }],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        };
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-collapse-test");
    const channel = await addHealthyChannel(store, secrets, { name: "collapse-mimo", baseUrl: mock.baseUrl, model: "mimo-v2.5" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "responses",
      model: "mimo-v2.5",
      stream: false,
      body: {
        model: "mimo-v2.5",
        input: [
          { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "list files" }] },
          {
            type: "message",
            id: "msg_a1",
            role: "assistant",
            content: [
              { type: "output_text", text: "I ran the command." },
              { type: "function_call", call_id: "call_1", id: "fc_1", name: "shell_command", arguments: "{\"command\":\"ls\"}", status: "completed" },
            ],
          },
          { type: "function_call_output", call_id: "call_1", id: "fco_1", output: "file1.txt" },
          { type: "message", id: "msg_u2", role: "user", content: [{ type: "input_text", text: "now what?" }] },
        ],
        stream: false,
      },
      clientName: "codex",
    };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-collapse", request, "mimo-v2.5", 1_000);

    expect(responsesCalls).toBe(3);
    // attempt 1: original structured history
    expect(JSON.stringify(received[0]?.input)).toContain("function_call");
    // attempt 2: flattened multi-turn text history
    expect(JSON.stringify(received[1]?.input)).not.toContain("function_call");
    expect(JSON.stringify(received[1]?.input)).toContain("[tool_call shell_command]");
    // attempt 3: single collapsed user message
    const collapsed = received[2]?.input;
    expect(Array.isArray(collapsed)).toBe(true);
    expect(collapsed).toHaveLength(1);
    expect(collapsed?.[0]).toMatchObject({ type: "message", role: "user" });
    const collapsedText = JSON.stringify(collapsed);
    expect(collapsedText).toContain("list files");
    expect(collapsedText).toContain("[tool_result] file1.txt");
    expect(JSON.parse(await readBody(attempt.result.body))).toMatchObject({ object: "response", model: "mimo-v2.5" });
  });

  it("normalizes a non-compliant tool-call stream into full events (mimo-v2.5)", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1/responses", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream" });
        reply.raw.end([
          ": keep-alive\n\n",
          "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"call_abc\",\"type\":\"function_call\",\"name\":\"shell_command\",\"call_id\":\"call_abc\",\"arguments\":\"\",\"status\":\"in_progress\"}}\n\n",
          "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"call_abc\",\"output_index\":0,\"delta\":\"{\\\"command\\\":\\\"ls\\\"}\"}\n\n",
          "event: response.completed\ndata: {\"id\":\"gen_tool\",\"type\":\"response.completed\",\"response\":{\"id\":\"gen_tool\",\"model\":\"mimo-v2.5\"}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return reply;
      });
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("openai-normalize-tool-test");
    const channel = await addHealthyChannel(store, secrets, { name: "normalize-tool-mimo", baseUrl: mock.baseUrl, model: "mimo-v2.5" });
    const request: GatewayRequest = {
      requestId: crypto.randomUUID(),
      kind: "responses",
      model: "mimo-v2.5",
      stream: true,
      body: { model: "mimo-v2.5", input: "你好", stream: true },
      clientName: "codex",
    };

    const attempt = await new OpenAiAdapter().execute(channel, "sk-normalize-tool", request, "mimo-v2.5", 1_000);
    const output = await readBody(attempt.result.body);

    // tool call is finalized with done events (no ghost message events)
    const types = [...output.matchAll(/"type":"([^"]+)"/g)].map((match) => match[1]);
    const expected = [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ];
    for (const type of expected) expect(types).toContain(type);
    expect(output).toContain('"name":"shell_command"');
    expect(output).toContain('"call_id":"call_abc"');
    // prelude precedes the tool call
    expect(output.indexOf('"type":"response.created"')).toBeLessThan(output.indexOf('"type":"response.output_item.added"'));
    expect(output).toContain('"type":"response.function_call_arguments.done"');
    expect(output).toContain('"type":"response.output_item.done"');
    expect(output).not.toContain('"type":"response.output_text.done"');
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

  it("normalizes models/ prefixes when routing Gemini upstream models", async () => {
    const mock = await startMockUpstream((app) => {
      app.post("/v1beta/models/gemini-upstream:generateContent", async () => ({
        candidates: [{ content: { role: "model", parts: [{ text: "gemini-ok" }] }, finishReason: "STOP" }],
      }));
    });
    servers.push(mock.app);
    const store = new MemoryStore();
    const secrets = createSecretBox("gemini-prefix-key");
    const channel = await addHealthyChannel(store, secrets, { name: "gemini-prefix", baseUrl: mock.baseUrl, protocol: "gemini", model: "models/gemini-upstream" });
    const request: GatewayRequest = { requestId: crypto.randomUUID(), kind: "chat", model: "gemini-local", stream: false, body: { model: "gemini-local", messages: [{ role: "user", content: "hello" }] }, clientName: "test" };

    const attempt = await new GeminiAdapter().execute(channel, "sk-test-gemini", request, "models/gemini-upstream", 1_000);
    const body = JSON.parse(await readBody(attempt.result.body));
    expect(body.choices[0].message.content).toBe("gemini-ok");
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
