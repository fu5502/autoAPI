import { describe, expect, it, vi } from "vitest";
import type { GatewayStore } from "../domain/store.js";
import type { Channel } from "../domain/types.js";
import type { AppDatabase, SiteChannelLink } from "./db.js";
import { CheckinBalanceSync } from "./channel-balance.js";
import type { Site } from "./types.js";

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 1,
    name: "Check-in Relay",
    baseUrl: "https://relay.example",
    note: "",
    faviconUrl: null,
    faviconCustom: false,
    adapter: "new-api-modern",
    enabled: true,
    authStatus: "valid",
    username: "admin",
    legacyUserId: null,
    currencySymbol: "USD",
    quotaPerUnit: 1,
    displayScale: 1,
    lastBalanceRaw: 12.5,
    lastBalanceAmount: 12.5,
    lastCheckedAt: null,
    lastStatus: "success",
    lastRewardAmount: null,
    lastRewardAt: null,
    lastBalanceDeltaAmount: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    providerId: "provider-1",
    providerName: "Relay",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
    faviconUrl: null,
    protocol: "openai",
    keyCiphertext: "encrypted",
    keyName: "API Key",
    keyLast4: "1234",
    status: "healthy",
    enabled: true,
    priority: 0,
    weight: 100,
    minBalance: null,
    balance: null,
    balanceCurrency: null,
    balanceStatus: "unknown",
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

function createSync(site: Site, channels: Channel[], links: SiteChannelLink[] = []) {
  const updateChannelBalance = vi.fn(async (channelId: string, balance: number, currency: string | null) => {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? { ...channel, balance, balanceCurrency: currency } : null;
  });
  const db = {
    getSite: (siteId: number) => siteId === site.id ? site : null,
    listSites: () => [site],
    listChannelLinks: (siteId?: number) => siteId === undefined ? links : links.filter((link) => link.siteId === siteId),
  };
  const store = {
    getChannel: async (channelId: string) => channels.find((channel) => channel.id === channelId) ?? null,
    listChannels: async () => channels,
    updateChannelBalance,
  };

  return {
    sync: new CheckinBalanceSync(db as unknown as AppDatabase, store as unknown as GatewayStore),
    updateChannelBalance,
  };
}

describe("CheckinBalanceSync", () => {
  it("syncs a check-in balance to a same-site versioned API channel", async () => {
    const site = makeSite();
    const channel = makeChannel();
    const { sync, updateChannelBalance } = createSync(site, [channel]);

    await expect(sync.syncSite(site.id)).resolves.toEqual({ updatedChannelIds: [channel.id], skippedBecauseBalanceIsUnknown: false });
    expect(updateChannelBalance).toHaveBeenCalledWith(channel.id, 12.5, "USD");
  });

  it("syncs an explicitly linked channel even when its Base URL differs", async () => {
    const site = makeSite();
    const channel = makeChannel({ id: "manual-channel", baseUrl: "https://another-gateway.example/v1" });
    const { sync, updateChannelBalance } = createSync(site, [channel], [{ siteId: site.id, channelId: channel.id, createdAt: "2026-01-01T00:00:00.000Z" }]);

    await expect(sync.syncSite(site.id)).resolves.toEqual({ updatedChannelIds: [channel.id], skippedBecauseBalanceIsUnknown: false });
    expect(updateChannelBalance).toHaveBeenCalledWith(channel.id, 12.5, "USD");
  });

  it("does not overwrite a channel balance when the check-in site has no readable balance", async () => {
    const site = makeSite({ lastBalanceAmount: null, lastBalanceRaw: null });
    const channel = makeChannel();
    const { sync, updateChannelBalance } = createSync(site, [channel], [{ siteId: site.id, channelId: channel.id, createdAt: "2026-01-01T00:00:00.000Z" }]);

    await expect(sync.syncSite(site.id)).resolves.toEqual({ updatedChannelIds: [], skippedBecauseBalanceIsUnknown: true });
    expect(updateChannelBalance).not.toHaveBeenCalled();
  });
});
