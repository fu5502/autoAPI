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
    [401, "upstream_auth_failed"],
    [403, "upstream_auth_failed"],
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

  it("does not degrade a channel for a non-retryable client request error", async () => {
    const rejected = await mockJson((_, reply) => reply.code(400).send({ error: { message: "invalid request payload" } }));
    const { router, store, secrets } = testRouter();
    const channel = await addHealthyChannel(store, secrets, { name: "client-error", baseUrl: rejected.baseUrl, priority: 20 });

    await expect(router.execute(gatewayRequest(false))).rejects.toMatchObject({ statusCode: 400, errorType: "upstream_rejected" });
    expect(await store.getChannel(channel.id)).toMatchObject({ status: "healthy", consecutiveFailures: 0, isolationReason: null });
    expect(store.usage[0]).toMatchObject({ statusCode: 400, errorType: "upstream_rejected" });
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

  it("polls an isolated channel when no normal candidates are available", async () => {
    let calls = 0;
    const upstream = await mockJson((_, reply) => {
      calls += 1;
      return reply.send(completion("recovered"));
    });
    const { router, store, secrets } = testRouter();
    const channel = await addHealthyChannel(store, secrets, { name: "isolated-poll", baseUrl: upstream.baseUrl });
    const failure = {
      ok: false,
      protocol: "openai" as const,
      models: [],
      latencyMs: 10,
      chatOk: false,
      streamOk: false,
      balance: null,
      balanceCurrency: null,
      balanceStatus: "unknown" as const,
      error: "connection_error",
    };
    await store.applyProbeResult(channel.id, failure, 2);
    await store.applyProbeResult(channel.id, failure, 2);
    expect((await store.getChannel(channel.id))?.status).toBe("isolated");

    const result = await router.execute(gatewayRequest(false));

    expect(JSON.parse(await readBody(result.body)).choices[0].message.content).toBe("recovered");
    expect(result.channelId).toBe(channel.id);
    expect(calls).toBe(1);
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ channelId: channel.id, statusCode: 200, errorType: null });
    expect((await store.getChannel(channel.id))?.status).toBe("healthy");
  });

  it("records protocol-incompatible fallback candidates on their channel", async () => {
    let calls = 0;
    const upstream = await mockJson(() => {
      calls += 1;
      return completion("must-not-run");
    });
    const { router, store, secrets } = testRouter();
    const channel = await addHealthyChannel(store, secrets, {
      name: "claude-responses",
      baseUrl: upstream.baseUrl,
      protocol: "claude",
    });
    const request: GatewayRequest = {
      ...gatewayRequest(false),
      kind: "responses",
      body: { ...gatewayRequest(false).body, stream: false },
    };

    await expect(router.execute(request)).rejects.toMatchObject({
      statusCode: 503,
      errorType: "unsupported_protocol",
    });
    expect(calls).toBe(0);
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({
      channelId: channel.id,
      statusCode: 503,
      errorType: "unsupported_protocol",
    });
  });

  it("does not write a null-channel usage row when no route exists", async () => {
    const { router, store } = testRouter();

    await expect(router.execute(gatewayRequest(false))).rejects.toMatchObject({
      statusCode: 503,
      errorType: "no_route_configured",
    });
    expect(store.usage).toHaveLength(0);
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

  it("keeps using a successful fallback and advances to the next healthy channel after another failure", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let reserveCalls = 0;
    let fallbackAvailable = true;
    const primary = await mockJson((_, reply) => {
      primaryCalls += 1;
      return reply.code(503).send({ error: { message: "primary unavailable" } });
    });
    const fallback = await mockJson((_, reply) => {
      fallbackCalls += 1;
      return fallbackAvailable
        ? reply.send(completion("fallback-response"))
        : reply.code(503).send({ error: { message: "fallback unavailable" } });
    });
    const reserve = await mockJson((_, reply) => {
      reserveCalls += 1;
      return reply.send(completion("reserve-response"));
    });
    const { router, store, secrets } = testRouter();
    const primaryChannel = await addHealthyChannel(store, secrets, { name: "primary", baseUrl: primary.baseUrl, priority: 30 });
    const fallbackChannel = await addHealthyChannel(store, secrets, { name: "fallback", baseUrl: fallback.baseUrl, priority: 20 });
    const reserveChannel = await addHealthyChannel(store, secrets, { name: "reserve", baseUrl: reserve.baseUrl, priority: 10 });

    expect((await router.execute(gatewayRequest(false))).channelId).toBe(fallbackChannel.id);
    expect((await router.execute(gatewayRequest(false))).channelId).toBe(fallbackChannel.id);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(2);

    fallbackAvailable = false;
    expect((await router.execute(gatewayRequest(false))).channelId).toBe(reserveChannel.id);
    expect((await router.execute(gatewayRequest(false))).channelId).toBe(reserveChannel.id);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(3);
    expect(reserveCalls).toBe(2);
    expect((await store.getChannel(primaryChannel.id))?.status).toBe("degraded");
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
    const primary = await addHealthyChannel(store, secrets, { name: "primary", baseUrl: interrupted.baseUrl, priority: 20 });
    await addHealthyChannel(store, secrets, { name: "fallback", baseUrl: fallback.baseUrl, priority: 20 });

    const output = await readBody((await router.execute(gatewayRequest(true))).body);
    expect(output).toContain("first-upstream");
    expect(output).toContain("upstream_stream_interrupted");
    expect(output).not.toContain("fallback-must-not-appear");
    expect(fallbackCalls).toBe(0);
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ channelId: primary.id, statusCode: 502, errorType: "upstream_stream_interrupted" });
    expect(await store.getChannel(primary.id)).toMatchObject({ status: "degraded", consecutiveFailures: 1 });
  });

  it("uses the timeout for connection and first byte without cutting off a healthy long stream", async () => {
    const upstream = await mockStream((_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n");
      setTimeout(() => reply.raw.end("data: {\"choices\":[{\"delta\":{\"content\":\"-later\"}}]}\n\ndata: [DONE]\n\n"), 80);
      return reply;
    });
    const { router, store, secrets } = testRouter(new MemoryStore(), 30);
    await addHealthyChannel(store, secrets, { name: "long-stream", baseUrl: upstream.baseUrl });

    const output = await readBody((await router.execute(gatewayRequest(true))).body);
    expect(output).toContain("first");
    expect(output).toContain("-later");
    expect(store.usage[0]).toMatchObject({ statusCode: 200, errorType: null });
  });

  it("records streaming token usage after the client consumes the response", async () => {
    const upstream = await mockStream((_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":4}}}\n\n",
        "data: [DONE]\n\n",
      ].join(""));
      return reply;
    });
    const { router, store, secrets } = testRouter();
    await addHealthyChannel(store, secrets, { name: "stream-usage", baseUrl: upstream.baseUrl });

    const result = await router.execute(gatewayRequest(true));
    expect(store.usage).toHaveLength(0);
    await readBody(result.body);
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ promptTokens: 12, completionTokens: 3, cachedTokens: 4, firstByteLatencyMs: expect.any(Number) });
  });

  it("records a client-cancelled stream without degrading the upstream channel", async () => {
    const upstream = await mockStream((_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n");
      setTimeout(() => reply.raw.end("data: [DONE]\n\n"), 1_000);
      return reply;
    });
    const { router, store, secrets } = testRouter();
    const channel = await addHealthyChannel(store, secrets, { name: "cancelled-stream", baseUrl: upstream.baseUrl });

    const result = await router.execute(gatewayRequest(true));
    if (result.body instanceof Uint8Array) throw new Error("Expected a streaming response");
    const iterator = result.body[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();

    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ statusCode: 499, errorType: "client_closed_request" });
    expect(await store.getChannel(channel.id)).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
  });
});

function testRouter(store = new MemoryStore(), timeoutMs = 1_000) {
  const secrets = createSecretBox("router-integration-test-key");
  const router = new GatewayRouter({
    store,
    secrets,
    runtime: new MemoryRuntimeState(),
    registry: new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]),
    timeoutMs,
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
