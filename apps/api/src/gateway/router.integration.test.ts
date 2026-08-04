import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory-store.js";
import type { GatewayRequest } from "../domain/types.js";
import { MemoryRuntimeState } from "../runtime/runtime-state.js";
import { createSecretBox } from "../security/secret-box.js";
import { addHealthyChannel, readBody, startMockUpstream } from "../test/test-helpers.js";
import { AdapterRegistry } from "./adapter.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { GeminiAdapter } from "./adapters/gemini-adapter.js";
import { OpenAiAdapter } from "./adapters/openai-adapter.js";
import { GatewayRouter } from "./router.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("gateway router failover", () => {
  it.each([
    [429, "rate_limited"],
    [503, "upstream_5xx"],
  ])("replays a non-streaming request after upstream %s", async (statusCode, expectedError) => {
    let fallbackCalls = 0;
    const failing = await mockJson((_, reply) => reply.code(statusCode).send({ error: { message: "temporary upstream failure" } }));
    const healthy = await mockJson((_, reply) => {
      fallbackCalls += 1;
      return reply.send(completion("fallback-response"));
    });
    const { router, store, secrets } = testRouter();
    await addHealthyChannel(store, secrets, { name: "primary", baseUrl: failing.baseUrl, priority: 20 });
    const fallback = await addHealthyChannel(store, secrets, { name: "fallback", baseUrl: healthy.baseUrl, priority: 20 });

    const result = await router.execute(gatewayRequest(false));
    expect(JSON.parse(await readBody(result.body)).choices[0].message.content).toBe("fallback-response");
    expect(result.channelId).toBe(fallback.id);
    expect(fallbackCalls).toBe(1);
    expect(store.usage).toHaveLength(2);
    expect(store.usage[0]?.errorType).toBe(expectedError);
    expect(store.usage[1]?.retryCount).toBe(1);
  });

  it("skips a channel disabled after candidate selection", async () => {
    let disabledCalls = 0;
    const disabledUpstream = await mockJson(() => {
      disabledCalls += 1;
      return { ignored: true };
    });
    const healthy = await mockJson((_, reply) => reply.send(completion("fallback-response")));
    const store = new DisableFirstCandidateStore();
    const { router, secrets } = testRouter(store);
    const disabled = await addHealthyChannel(store, secrets, {
      name: "disabled-before-attempt",
      baseUrl: disabledUpstream.baseUrl,
      priority: 20,
    });
    const fallback = await addHealthyChannel(store, secrets, {
      name: "fallback",
      baseUrl: healthy.baseUrl,
      priority: 20,
    });
    store.channelToDisable = disabled.id;

    const result = await router.execute(gatewayRequest(false));

    expect(result.channelId).toBe(fallback.id);
    expect(disabledCalls).toBe(0);
  });

  it("round-robins healthy channels across requests", async () => {
    const calls: string[] = [];
    const first = await mockJson((_, reply) => {
      calls.push("first");
      return reply.send(completion("first-response"));
    });
    const second = await mockJson((_, reply) => {
      calls.push("second");
      return reply.send(completion("second-response"));
    });
    const { router, store, secrets } = testRouter();
    const firstChannel = await addHealthyChannel(store, secrets, { name: "first", baseUrl: first.baseUrl, priority: 20, weight: 1 });
    const secondChannel = await addHealthyChannel(store, secrets, { name: "second", baseUrl: second.baseUrl, priority: 20, weight: 1 });

    expect((await router.execute(gatewayRequest(false))).channelId).toBe(firstChannel.id);
    expect((await router.execute(gatewayRequest(false))).channelId).toBe(secondChannel.id);
    expect((await router.execute(gatewayRequest(false))).channelId).toBe(firstChannel.id);
    expect(calls).toEqual(["first", "second", "first"]);
  });

  it("switches streams when the first upstream ends before emitting an event", async () => {
    let fallbackCalls = 0;
    const failing = await mockStream((_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.flushHeaders();
      setTimeout(() => reply.raw.destroy(), 5);
      return reply;
    });
    const healthy = await mockStream((_request, reply) => {
      fallbackCalls += 1;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"from-fallback\"}}]}\n\ndata: [DONE]\n\n");
      return reply;
    });
    const { router, store, secrets } = testRouter();
    await addHealthyChannel(store, secrets, { name: "primary", baseUrl: failing.baseUrl, priority: 20 });
    await addHealthyChannel(store, secrets, { name: "fallback", baseUrl: healthy.baseUrl, priority: 20 });

    const output = await readBody((await router.execute(gatewayRequest(true))).body);
    expect(output).toContain("from-fallback");
    expect(fallbackCalls).toBe(1);
  });

  it("never splices a fallback stream after the first event was emitted", async () => {
    let fallbackCalls = 0;
    const interrupted = await mockStream((_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write("data: {\"choices\":[{\"delta\":{\"content\":\"first-upstream\"}}]}\n\n");
      setTimeout(() => reply.raw.destroy(), 8);
      return reply;
    });
    const fallback = await mockStream((_request, reply) => {
      fallbackCalls += 1;
      return reply.send("data: fallback-must-not-appear\n\n");
    });
    const { router, store, secrets } = testRouter();
    await addHealthyChannel(store, secrets, { name: "primary", baseUrl: interrupted.baseUrl, priority: 20 });
    await addHealthyChannel(store, secrets, { name: "fallback", baseUrl: fallback.baseUrl, priority: 20 });

    const output = await readBody((await router.execute(gatewayRequest(true))).body);
    expect(output).toContain("first-upstream");
    expect(output).toContain("upstream_stream_interrupted");
    expect(output).not.toContain("fallback-must-not-appear");
    expect(fallbackCalls).toBe(0);
  });
});

function testRouter(store = new MemoryStore()) {
  const secrets = createSecretBox("router-integration-test-key");
  const router = new GatewayRouter({
    store,
    secrets,
    runtime: new MemoryRuntimeState(),
    registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
    timeoutMs: 1_000,
    failureThreshold: 3,
  });
  return { router, store, secrets };
}

class DisableFirstCandidateStore extends MemoryStore {
  channelToDisable: string | null = null;
  private disabled = false;

  override async getChannel(id: string) {
    if (id === this.channelToDisable && !this.disabled) {
      this.disabled = true;
      await super.setChannelEnabled(id, false);
    }
    return super.getChannel(id);
  }
}

function gatewayRequest(stream: boolean): GatewayRequest {
  return {
    requestId: crypto.randomUUID(),
    kind: "chat",
    model: "test-model",
    stream,
    body: { model: "test-model", messages: [{ role: "user", content: "hello" }], stream },
    clientName: "codex-test",
  };
}

async function mockJson(handler: RouteHandlerMethod) {
  const mock = await startMockUpstream((app) => app.post("/v1/chat/completions", handler));
  servers.push(mock.app);
  return mock;
}

async function mockStream(handler: RouteHandlerMethod) {
  return mockJson(handler);
}

function completion(content: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  };
}
