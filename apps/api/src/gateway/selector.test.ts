import { describe, expect, it } from "vitest";
import type { Channel, GatewayRequest, RoutingCandidate } from "../domain/types.js";
import { AdapterRegistry } from "./adapter.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { GeminiAdapter } from "./adapters/gemini-adapter.js";
import { OpenAiAdapter } from "./adapters/openai-adapter.js";
import { eligibleCandidates, orderCandidates } from "./selector.js";

const registry = new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]);
const request: GatewayRequest = {
  requestId: crypto.randomUUID(),
  kind: "chat",
  model: "gpt-test",
  stream: false,
  body: { model: "gpt-test", messages: [] },
  clientName: "test",
};

describe("routing selector", () => {
  it("filters isolated, exhausted, cooling, and protocol-incompatible channels", () => {
    const candidates = [
      candidate(channel({ id: "healthy" })),
      candidate(channel({ id: "isolated", status: "isolated" })),
      candidate(channel({ id: "empty", balanceStatus: "exhausted" })),
      candidate(channel({ id: "cooling", cooldownUntil: new Date(Date.now() + 60_000).toISOString() })),
      candidate(channel({ id: "claude", protocol: "claude" })),
    ];

    expect(eligibleCandidates(candidates, request, registry).map((item) => item.channel.id)).toEqual(["healthy"]);
  });

  it("uses priority before weight and rotates within the highest priority", () => {
    const candidates = [
      candidate(channel({ id: "primary-a", priority: 20, weight: 100 })),
      candidate(channel({ id: "primary-b", priority: 20, weight: 50 })),
      candidate(channel({ id: "reserve", priority: 10, weight: 10_000 })),
    ];

    expect(orderCandidates(candidates, 0).map((item) => item.channel.id)).toEqual(["primary-a", "primary-b", "reserve"]);
    expect(orderCandidates(candidates, 100).map((item) => item.channel.id)).toEqual(["primary-b", "primary-a", "reserve"]);
  });

  it("filters a channel below its configured minimum balance", () => {
    const belowMinimum = candidate(channel({ id: "low", balance: 0.2, minBalance: 1 }));
    expect(eligibleCandidates([belowMinimum], request, registry)).toHaveLength(0);
  });

  it("skips disabled channels", () => {
    const candidates = [
      candidate(channel({ id: "enabled" })),
      candidate(channel({ id: "disabled", enabled: false, status: "disabled" })),
    ];

    expect(eligibleCandidates(candidates, request, registry).map((item) => item.channel.id)).toEqual(["enabled"]);
  });

  it("keeps pending channels in the routing pool", () => {
    const pending = candidate(channel({ id: "pending", status: "pending" }));
    expect(eligibleCandidates([pending], request, registry).map((item) => item.channel.id)).toEqual(["pending"]);
  });

  it("prefers the last successful channel and postpones temporarily penalized channels", () => {
    const candidates = [
      candidate(channel({ id: "primary-a", priority: 30, weight: 100 })),
      candidate(channel({ id: "fallback-b", priority: 20, weight: 100 })),
      candidate(channel({ id: "reserve-c", priority: 10, weight: 100 })),
    ];

    expect(orderCandidates(candidates, 0, {
      preferredChannelId: "fallback-b",
      channelPenalties: { "primary-a": 1 },
    }).map((item) => item.channel.id)).toEqual(["fallback-b", "reserve-c", "primary-a"]);
  });
});

function candidate(value: Channel): RoutingCandidate {
  return { channel: value, upstreamModel: "gpt-upstream" };
}

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "channel",
    providerId: "provider",
    providerName: "Provider",
    name: "Channel",
    baseUrl: "https://example.test",
    faviconUrl: null,
    protocol: "openai",
    keyCiphertext: "ciphertext",
    keyLast4: "test",
    status: "healthy",
    enabled: true,
    priority: 10,
    weight: 100,
    minBalance: null,
    balance: 10,
    balanceCurrency: "USD",
    balanceStatus: "ok",
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolationReason: null,
    lastCheckedAt: new Date().toISOString(),
    lastLatencyMs: 100,
    recentRequestCount: 0,
    recentErrorRate: 0,
    models: ["gpt-upstream"],
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
