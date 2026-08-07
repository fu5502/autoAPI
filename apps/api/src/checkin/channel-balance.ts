import type { GatewayStore } from "../domain/store.js";
import type { Channel } from "../domain/types.js";
import type { AppDatabase } from "./db.js";
import type { Site } from "./types.js";

export interface CheckinBalanceSyncResult {
  updatedChannelIds: string[];
  skippedBecauseBalanceIsUnknown: boolean;
}

export interface CheckinBalanceSyncOptions {
  /** Used by the gateway-wide refresh so disabled channels are never updated indirectly. */
  onlyEnabledChannels?: boolean;
}

/** Keeps check-in balances aligned with explicitly linked or same-site channels. */
export class CheckinBalanceSync {
  constructor(
    private readonly db: AppDatabase,
    private readonly store: GatewayStore,
  ) {}

  async linkChannel(siteId: number, channelId: string): Promise<{ channel: Channel; synced: boolean }> {
    const site = this.db.getSite(siteId);
    if (!site) throw new Error("Check-in site not found");
    const channel = await this.store.getChannel(channelId);
    if (!channel) throw new Error("Channel not found");

    this.db.linkChannel(siteId, channelId);
    const result = await this.syncSite(siteId);
    return {
      channel: (await this.store.getChannel(channelId)) ?? channel,
      synced: result.updatedChannelIds.includes(channelId),
    };
  }

  async syncAll(options: CheckinBalanceSyncOptions = {}): Promise<CheckinBalanceSyncResult> {
    const updatedChannelIds = new Set<string>();
    let skippedBecauseBalanceIsUnknown = false;
    for (const site of this.db.listSites()) {
      const result = await this.syncSite(site.id, options);
      for (const channelId of result.updatedChannelIds) updatedChannelIds.add(channelId);
      skippedBecauseBalanceIsUnknown ||= result.skippedBecauseBalanceIsUnknown;
    }
    return { updatedChannelIds: [...updatedChannelIds], skippedBecauseBalanceIsUnknown };
  }

  async syncSite(siteId: number, options: CheckinBalanceSyncOptions = {}): Promise<CheckinBalanceSyncResult> {
    const site = this.db.getSite(siteId);
    if (!site || site.lastBalanceAmount === null) {
      return { updatedChannelIds: [], skippedBecauseBalanceIsUnknown: Boolean(site) };
    }

    const channels = await this.store.listChannels();
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    const isEligible = (channelId: string) => {
      if (!options.onlyEnabledChannels) return true;
      const channel = channelsById.get(channelId);
      return Boolean(channel?.enabled && channel.status !== "disabled");
    };
    const linkedChannelIds = new Set(this.db.listChannelLinks(siteId).map((link) => link.channelId));
    const targetChannelIds = new Set([
      ...[...linkedChannelIds].filter(isEligible),
      ...channels
        .filter((channel) => (!options.onlyEnabledChannels || (channel.enabled && channel.status !== "disabled")) && matchesCheckinSite(channel.baseUrl, site))
        .map((channel) => channel.id),
    ]);
    const updatedChannelIds: string[] = [];

    for (const channelId of targetChannelIds) {
      const updated = await this.store.updateChannelBalance(channelId, site.lastBalanceAmount, site.currencySymbol || null);
      if (updated) updatedChannelIds.push(channelId);
    }
    return { updatedChannelIds, skippedBecauseBalanceIsUnknown: false };
  }
}

export function matchesCheckinSite(channelBaseUrl: string, site: Pick<Site, "baseUrl">): boolean {
  try {
    const channel = new URL(withHttpScheme(channelBaseUrl));
    const checkin = new URL(withHttpScheme(site.baseUrl));
    if (channel.origin !== checkin.origin) return false;

    const sitePath = normalizeUrlPath(checkin.pathname);
    const channelPath = normalizeUrlPath(channel.pathname);
    if (channelPath === sitePath) return true;
    if (isVersionedApiPath(channelPath, sitePath, "v1") || isVersionedApiPath(channelPath, sitePath, "v1beta")) return true;
    return sitePath === "/" && /^\/v1(?:beta)?(?:\/|$)/i.test(channelPath);
  } catch {
    return false;
  }
}

function isVersionedApiPath(channelPath: string, sitePath: string, version: "v1" | "v1beta"): boolean {
  const prefix = sitePath === "/" ? "" : sitePath;
  const apiPath = `${prefix}/${version}`;
  return channelPath === apiPath || channelPath.startsWith(`${apiPath}/`);
}

function withHttpScheme(value: string): string {
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
}

function normalizeUrlPath(value: string): string {
  const path = `/${value.replace(/^\/+|\/+$/g, "")}`;
  return path === "/" ? "/" : path.toLowerCase();
}
