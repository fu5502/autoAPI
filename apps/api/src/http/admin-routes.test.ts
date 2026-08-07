import { describe, expect, it } from "vitest";
import type { Channel } from "../domain/types.js";
import type { Site } from "../checkin/types.js";
import { applyCheckinBalance, matchesCheckinSite, serializeAdminChannel } from "./admin-routes.js";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    providerId: "00000000-0000-4000-8000-000000000002",
    providerName: "Relay",
    name: "Relay channel",
    baseUrl: "https://relay.example/v1",
    faviconUrl: null,
    protocol: "openai",
    keyCiphertext: "ciphertext",
    keyName: "WorkBuddy",
    keyLast4: "1234",
    status: "healthy",
    enabled: true,
    priority: 0,
    weight: 100,
    minBalance: null,
    balance: 99,
    balanceCurrency: "USD",
    balanceStatus: "ok",
    consecutiveFailures: 0,
    cooldownUntil: null,
    isolationReason: null,
    lastCheckedAt: null,
    lastLatencyMs: null,
    recentRequestCount: 0,
    recentErrorRate: 0,
    models: ["gpt-test"],
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 1,
    name: "公益站",
    baseUrl: "https://relay.example",
    note: "",
    faviconUrl: null,
    faviconCustom: false,
    adapter: "new-api-modern",
    enabled: true,
    authStatus: "valid",
    username: "admin",
    legacyUserId: null,
    currencySymbol: "¥",
    quotaPerUnit: 500000,
    displayScale: 1,
    lastBalanceRaw: 3500000,
    lastBalanceAmount: 3.5,
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
    lastStatus: "success",
    lastRewardAmount: 0,
    lastRewardAt: null,
    lastBalanceDeltaAmount: 0,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkin site balance integration", () => {
  it("uses the matching check-in site's balance and currency", () => {
    const channel = makeChannel({ minBalance: 5 });
    const result = applyCheckinBalance(channel, { listSites: () => [makeSite()], listChannelLinks: () => [] });

    expect(result).toMatchObject({
      balance: 3.5,
      balanceCurrency: "¥",
      balanceStatus: "low",
    });
  });

  it("keeps the channel balance when the matching site has no readable balance", () => {
    const channel = makeChannel();
    const result = applyCheckinBalance(channel, {
      listSites: () => [makeSite({ lastBalanceAmount: null, lastBalanceRaw: null })],
      listChannelLinks: () => [],
    });

    expect(result).toEqual(channel);
  });

  it("keeps ordinary channel balances when no check-in site matches", () => {
    const channel = makeChannel({ baseUrl: "https://other.example/v1" });
    const result = applyCheckinBalance(channel, { listSites: () => [makeSite()], listChannelLinks: () => [] });

    expect(result).toEqual(channel);
  });

  it("keeps a zero check-in balance as a known exhausted balance", () => {
    const result = applyCheckinBalance(makeChannel(), {
      listSites: () => [makeSite({ lastBalanceAmount: 0 })],
      listChannelLinks: () => [],
    });

    expect(result).toMatchObject({ balance: 0, balanceStatus: "exhausted" });
  });

  it("matches only exact versioned API path boundaries", () => {
    const site = makeSite({ baseUrl: "https://relay.example/api" });

    expect(matchesCheckinSite("https://relay.example/api/v1", site)).toBe(true);
    expect(matchesCheckinSite("https://relay.example/api/v1/chat/completions", site)).toBe(true);
    expect(matchesCheckinSite("https://relay.example/api/v1beta/models", site)).toBe(true);
    expect(matchesCheckinSite("https://relay.example/api/v11", site)).toBe(false);
    expect(matchesCheckinSite("https://relay.example/api/v1beta2", site)).toBe(false);
  });

  it("adds the explicitly linked check-in site to an admin channel without exposing its key", () => {
    const channel = makeChannel();
    const site = makeSite({
      id: 7,
      name: "关联签到站",
      baseUrl: "https://another.example",
      faviconUrl: "https://another.example/icon.png",
      lastBalanceUpdatedAt: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const result = serializeAdminChannel(channel, {
      listSites: () => [site],
      listChannelLinks: () => [{ siteId: site.id, channelId: channel.id, createdAt: "2026-01-02T00:00:00.000Z" }],
    });

    expect(result.checkinSite).toEqual({
      id: 7,
      name: "关联签到站",
      baseUrl: "https://another.example",
      faviconUrl: "https://another.example/icon.png",
      lastBalanceUpdatedAt: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("keyCiphertext");
  });

  it("adds a same-site check-in reference when the channel is not explicitly linked", () => {
    const channel = makeChannel({ baseUrl: "https://relay.example/v1" });
    const result = serializeAdminChannel(channel, {
      listSites: () => [makeSite({ id: 3, faviconUrl: "https://relay.example/favicon.ico" })],
      listChannelLinks: () => [],
    });

    expect(result.checkinSite?.id).toBe(3);
  });

  it("does not add a check-in reference for an unrelated channel", () => {
    const result = serializeAdminChannel(makeChannel({ baseUrl: "https://other.example/v1" }), {
      listSites: () => [makeSite()],
      listChannelLinks: () => [],
    });

    expect(result.checkinSite).toBeNull();
  });
});
