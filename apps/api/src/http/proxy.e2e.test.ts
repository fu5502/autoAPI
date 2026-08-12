import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { MemoryRuntimeState } from "../runtime/runtime-state.js";
import { createSecretBox } from "../security/secret-box.js";
import { hashGatewayKey } from "../security/gateway-key.js";
import { addHealthyChannel, startMockUpstream } from "../test/test-helpers.js";

const resources: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("proxy HTTP surface", () => {
  it("exposes one authenticated endpoint for model listing and completion routing", async () => {
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/chat/completions", async () => ({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "gateway-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-test-token",
      GATEWAY_API_KEY: "gateway-test-token",
      CREDENTIAL_ENCRYPTION_KEY: "e2e-test-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "e2e", baseUrl: mock.baseUrl, model: "gpt-e2e" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    const unauthorized = await built.app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthorized.statusCode).toBe(401);

    const models = await built.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer gateway-test-token" } });
    expect(models.statusCode).toBe(200);
    expect(models.json().data[0].id).toBe("gpt-e2e");

    const claudeModels = await built.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": "gateway-test-token", "user-agent": "ClaudeCode/1.0" },
    });
    expect(claudeModels.statusCode).toBe(200);
    expect(claudeModels.json()).toMatchObject({ data: [{ type: "model", id: "gpt-e2e", display_name: "gpt-e2e" }] });

    const completion = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer gateway-test-token", "x-autoapi-client": "codex-e2e" },
      payload: { model: "gpt-e2e", messages: [{ role: "user", content: "hello" }] },
    });
    expect(completion.statusCode).toBe(200);
    expect(completion.json().choices[0].message.content).toBe("gateway-ok");
    expect(completion.headers["x-autoapi-channel"]).toBeTruthy();

    const admin = await built.app.inject({ method: "GET", url: "/admin/usage?window=1h", headers: { authorization: "Bearer admin-test-token" } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ totalRequests: 1, byClient: [{ name: "codex-e2e", requests: 1 }] });
  });

  it("accepts CPA-style api-key auth and bridges Codex Responses to Chat Completions", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/responses", async (_, reply) => reply.code(404).send({ error: { message: "not supported" } }));
      upstream.post("/v1/chat/completions", async (request) => {
        capturedBody = request.body as Record<string, unknown>;
        return {
          id: "chatcmpl-bridge",
          object: "chat.completion",
          created: 1_700_000_000,
          choices: [{ index: 0, message: { role: "assistant", content: "bridge-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        };
      });
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-test-token",
      GATEWAY_API_KEY: "gateway-test-token",
      CREDENTIAL_ENCRYPTION_KEY: "bridge-test-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "bridge", baseUrl: mock.baseUrl, model: "gpt-5-codex" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    const response = await built.app.inject({
      method: "POST",
      url: "/codex/v1/responses",
      headers: { "api-key": "gateway-test-token", "user-agent": "Codex/1.0" },
      payload: {
        model: "gpt-5-codex",
        instructions: "Be concise",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "response", model: "gpt-5-codex", output_text: "bridge-ok" });
    expect(capturedBody).toMatchObject({
      model: "gpt-5-codex",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("collapses Codex multi-turn history to one message after a 400 for mimo-v2.5", async () => {
    const received: Array<{ input?: unknown[]; model?: string }> = [];
    let responsesCalls = 0;
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/responses", async (request, reply) => {
        responsesCalls += 1;
        received.push(request.body as { input?: unknown[]; model?: string });
        if (responsesCalls === 1) {
          return reply.code(400).send({ error: { message: "Provider returned error" } });
        }
        return {
          id: "resp_collapse_e2e",
          object: "response",
          status: "completed",
          model: "mimo-v2.5",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "collapse-e2e-ok", annotations: [] }] }],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        };
      });
      upstream.post("/v1/chat/completions", async () => {
        throw new Error("chat must not be called");
      });
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-collapse-token",
      GATEWAY_API_KEY: "gateway-collapse-token",
      CREDENTIAL_ENCRYPTION_KEY: "collapse-e2e-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "collapse-e2e-mimo", baseUrl: mock.baseUrl, model: "mimo-v2.5" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    const response = await built.app.inject({
      method: "POST",
      url: "/codex/v1/responses",
      headers: { "api-key": "gateway-collapse-token", "user-agent": "Codex/1.0" },
      payload: {
        model: "mimo-v2.5",
        instructions: "Be concise",
        input: [
          { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "list files" }] },
          { type: "message", id: "msg_a1", role: "assistant", content: [{ type: "output_text", text: "done" }] },
          { type: "message", id: "msg_u2", role: "user", content: [{ type: "input_text", text: "now what?" }] },
        ],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autoapi-channel"]).toBeTruthy();
    expect(responsesCalls).toBe(2);
    expect(received[0]?.model).toBe("mimo-v2.5");
    expect(received[1]?.input).toHaveLength(1);
    expect(JSON.stringify(received[1]?.input)).toContain("now what?");
    expect(response.json()).toMatchObject({ object: "response", model: "mimo-v2.5", status: "completed" });
  });

  it("preserves Codex function-call loops when Responses falls back to Chat Completions", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/responses", async (_, reply) => reply.code(404).send({ error: { message: "not supported" } }));
      upstream.post("/v1/chat/completions", async (request) => {
        capturedBody = request.body as Record<string, unknown>;
        return {
          id: "chatcmpl-tools",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_next", type: "function", function: { name: "write_file", arguments: "{\"path\":\"notes.txt\"}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        };
      });
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-tools-token",
      GATEWAY_API_KEY: "gateway-tools-token",
      CREDENTIAL_ENCRYPTION_KEY: "bridge-tools-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "tool-bridge", baseUrl: mock.baseUrl, model: "gpt-tools" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    const response = await built.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer gateway-tools-token", "user-agent": "Codex/1.0" },
      payload: {
        model: "gpt-tools",
        input: [
          { type: "function_call", call_id: "call_previous", name: "read_file", arguments: "{\"path\":\"notes.txt\"}" },
          { type: "function_call_output", call_id: "call_previous", output: "existing notes" },
        ],
        tools: [{ type: "function", name: "write_file", description: "Write a file", parameters: { type: "object" }, strict: true }],
        tool_choice: { type: "function", name: "write_file" },
        max_output_tokens: 200,
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedBody).toMatchObject({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_previous", function: { name: "read_file" } }] },
        { role: "tool", tool_call_id: "call_previous", content: "existing notes" },
      ],
      tools: [{ type: "function", function: { name: "write_file", description: "Write a file", parameters: { type: "object" }, strict: true } }],
      tool_choice: { type: "function", function: { name: "write_file" } },
      max_completion_tokens: 200,
    });
    expect(response.json().output).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call_next", name: "write_file", arguments: "{\"path\":\"notes.txt\"}" }),
    ]);
  });

  it("records the actual gateway key name used by each client request", async () => {
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/chat/completions", async () => ({
        id: "chatcmpl-key-name",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }));
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-test-token",
      GATEWAY_API_KEY: "unused-environment-key",
      CREDENTIAL_ENCRYPTION_KEY: "gateway-key-name-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    const secrets = createSecretBox(config.credentialEncryptionKey);
    await store.createGatewayKey("WorkBuddy", hashGatewayKey("workbuddy-token"), "oken", secrets.encrypt("workbuddy-token"));
    await store.createGatewayKey("cc", hashGatewayKey("cc-token"), "oken", secrets.encrypt("cc-token"));
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "key-name-channel", baseUrl: mock.baseUrl, model: "gpt-key-name" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    for (const token of ["workbuddy-token", "cc-token"]) {
      const response = await built.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "x-api-key": token },
        payload: { model: "gpt-key-name", messages: [{ role: "user", content: "hello" }] },
      });
      expect(response.statusCode).toBe(200);
    }

    const logs = await built.app.inject({ method: "GET", url: "/admin/requests?window=1h&limit=10", headers: { authorization: "Bearer admin-test-token" } });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().items.map((item: { gatewayKeyName: string }) => item.gatewayKeyName)).toEqual(["cc", "WorkBuddy"]);
  });

  it("records reasoning effort from OpenAI-compatible requests", async () => {
    const mock = await startMockUpstream((upstream) => {
      upstream.post("/v1/chat/completions", async () => ({
        id: "chatcmpl-reasoning",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }));
    });
    resources.push(mock.app);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_MODE: "demo",
      ADMIN_TOKEN: "admin-test-token",
      GATEWAY_API_KEY: "gateway-test-token",
      CREDENTIAL_ENCRYPTION_KEY: "reasoning-effort-encryption-key",
      UPSTREAM_TIMEOUT_MS: "1000",
    });
    const store = new MemoryStore();
    await addHealthyChannel(store, createSecretBox(config.credentialEncryptionKey), { name: "reasoning-channel", baseUrl: mock.baseUrl, model: "gpt-reasoning" });
    const built = await buildApp({ config, store, runtime: new MemoryRuntimeState(), startAgent: false });
    resources.push(built.app);

    const response = await built.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer gateway-test-token" },
      payload: {
        model: "gpt-reasoning",
        reasoning: { effort: "high" },
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(200);

    const logs = await built.app.inject({ method: "GET", url: "/admin/requests?window=1h&limit=10", headers: { authorization: "Bearer admin-test-token" } });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().items[0]).toMatchObject({ modelAlias: "gpt-reasoning", reasoningEffort: "high" });
  });
});
