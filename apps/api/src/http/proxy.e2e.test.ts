import type { FastifyInstance } from "fastify";
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
});
