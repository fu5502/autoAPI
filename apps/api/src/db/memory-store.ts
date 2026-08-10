import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayStore, ImportedProvider } from "../domain/store.js";
import type {
  Channel,
  ChannelUpdateInput,
  AdminAccount,
  AdminLoginRecord,
  GatewayKey,
  GatewayKeySummary,
  ModelAliasInput,
  ModelRoute,
  PoolSummary,
  ProbeResult,
  ProviderImportInput,
  RoutingCandidate,
  UsageEventInput,
  UsageSummary,
  PlaygroundSession,
  RequestLogFilters,
  RequestLogPage,
  RequestLogEntry,
} from "../domain/types.js";
import { buildPoolHealth, isHealthRelevantEvent } from "../domain/pool-health.js";

export class MemoryStore implements GatewayStore {
  readonly channels = new Map<string, Channel>();
  readonly routes: ModelRoute[] = [];
  readonly usage: Array<UsageEventInput & { createdAt: string }> = [];
  readonly playgroundSessions = new Map<string, PlaygroundSession>();
  readonly gatewayKeys = new Map<string, GatewayKey>();
  adminAccount: AdminAccount | null = null;
  readonly adminLoginHistory: AdminLoginRecord[] = [];

  async importProvider(
    input: ProviderImportInput,
    encryptedKey: string,
    keyLast4: string,
    keyName?: string,
  ): Promise<ImportedProvider> {
    const providerId = randomUUID();
    const id = randomUUID();
    const channel: Channel = {
      id,
      providerId,
      providerName: input.name,
      name: input.channelName ?? input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      faviconUrl: input.faviconUrl ?? null,
      protocol: input.protocol,
      keyCiphertext: encryptedKey,
      keyName: input.keyName?.trim() || keyName?.trim() || "API Key",
      keyLast4,
      status: "pending",
      enabled: true,
      priority: input.priority,
      weight: input.weight,
      minBalance: input.minBalance ?? null,
      balance: null,
      balanceCurrency: null,
      balanceUpdatedAt: null,
      balanceStatus: "unknown",
      consecutiveFailures: 0,
      cooldownUntil: null,
      isolationReason: null,
      lastCheckedAt: null,
      lastLatencyMs: null,
      recentRequestCount: 0,
      recentErrorRate: 0,
      models: input.models ?? [],
      tags: input.tags,
      createdAt: new Date().toISOString(),
    };
    this.channels.set(id, channel);
    for (const model of input.models ?? []) {
      await this.saveModelAlias({ alias: model, channelId: id, upstreamModel: model });
    }
    return { providerId, channel };
  }

  async getChannel(id: string): Promise<Channel | null> {
    return this.channels.get(id) ?? null;
  }

  async listChannels(): Promise<Channel[]> {
    return [...this.channels.values()].sort(compareChannelsByHealth);
  }

  async reorderChannels(channelIds: string[]): Promise<Channel[]> {
    const requested = new Set(channelIds);
    if (requested.size !== this.channels.size || [...this.channels.keys()].some((id) => !requested.has(id))) {
      throw new Error("Channel reorder must include every channel exactly once");
    }
    channelIds.forEach((id, index) => {
      const channel = this.channels.get(id);
      if (channel) channel.priority = channelIds.length - index;
    });
    return this.listChannels();
  }

  async updateChannel(id: string, input: ChannelUpdateInput, encryptedKey?: string, keyLast4?: string, keyName?: string): Promise<Channel | null> {
    const channel = this.channels.get(id);
    if (!channel) return null;
    channel.name = input.name;
    if (input.keyName !== undefined || keyName !== undefined) channel.keyName = input.keyName?.trim() || keyName?.trim() || "API Key";
    channel.baseUrl = input.baseUrl.replace(/\/+$/, "");
    if (input.faviconUrl !== undefined) channel.faviconUrl = input.faviconUrl;
    channel.protocol = input.protocol;
    channel.priority = input.priority;
    channel.weight = input.weight;
    channel.minBalance = input.minBalance;
    if (input.balance !== undefined) {
      channel.balance = input.balance;
      channel.balanceUpdatedAt = new Date().toISOString();
    }
    if (input.balanceCurrency !== undefined) channel.balanceCurrency = input.balanceCurrency;
    channel.balanceStatus = getBalanceStatus(channel.balance, channel.minBalance);
    channel.models = input.models;
    channel.tags = input.tags;
    channel.enabled = input.enabled ?? channel.enabled;
    if (encryptedKey && keyLast4) {
      channel.keyCiphertext = encryptedKey;
      channel.keyLast4 = keyLast4;
    }
    resetChannelHealth(channel);
    if (!channel.enabled) channel.status = "disabled";
    for (const route of this.routes) {
      if (route.channelId === id && route.alias === route.upstreamModel && !input.models.includes(route.upstreamModel)) {
        route.enabled = false;
      }
    }
    for (const model of input.models) {
      await this.saveModelAlias({ alias: model, channelId: id, upstreamModel: model, enabled: true });
    }
    return channel;
  }

  async updateChannelBalance(id: string, balance: number, balanceCurrency: string | null): Promise<Channel | null> {
    const channel = this.channels.get(id);
    if (!channel) return null;
    channel.balance = balance;
    channel.balanceCurrency = balanceCurrency;
    channel.balanceUpdatedAt = new Date().toISOString();
    channel.balanceStatus = getBalanceStatus(balance, channel.minBalance);
    return channel;
  }

  async deleteChannel(id: string): Promise<boolean> {
    const deleted = this.channels.delete(id);
    if (deleted) {
      for (let index = this.routes.length - 1; index >= 0; index -= 1) {
        if (this.routes[index]?.channelId === id) this.routes.splice(index, 1);
      }
    }
    return deleted;
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<Channel | null> {
    const channel = this.channels.get(id);
    if (!channel) return null;
    channel.enabled = enabled;
    resetChannelHealth(channel);
    channel.status = enabled ? "pending" : "disabled";
    return channel;
  }

  async listRoutingCandidates(modelAlias: string): Promise<RoutingCandidate[]> {
    return this.routes
      .filter((route) => route.alias === modelAlias && route.enabled)
      .flatMap((route) => {
        const channel = this.channels.get(route.channelId);
        return channel ? [{ channel, upstreamModel: route.upstreamModel }] : [];
      });
  }

  async saveModelAlias(input: ModelAliasInput): Promise<void> {
    const existing = this.routes.find(
      (route) => route.alias === input.alias && route.channelId === input.channelId && route.upstreamModel === input.upstreamModel,
    );
    if (existing) {
      existing.enabled = input.enabled ?? true;
      return;
    }
    this.routes.push({ id: randomUUID(), ...input, enabled: input.enabled ?? true });
  }

  async applyProbeResult(channelId: string, result: ProbeResult, failureThreshold: number): Promise<Channel> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error("Channel not found");
    channel.protocol = channel.protocol === "auto" ? result.protocol : channel.protocol;
    channel.consecutiveFailures = result.ok ? 0 : channel.consecutiveFailures + 1;
    const exhausted = result.balance !== null && channel.minBalance !== null && result.balance < channel.minBalance;
    const isolated = exhausted || (!result.ok && channel.consecutiveFailures >= failureThreshold);
    channel.status = result.ok && !exhausted ? "healthy" : isolated ? "isolated" : "degraded";
    channel.cooldownUntil = isolated ? new Date(Date.now() + 300_000).toISOString() : null;
    channel.isolationReason = exhausted ? "balance_below_minimum" : result.error;
    channel.lastCheckedAt = new Date().toISOString();
    channel.lastLatencyMs = result.latencyMs;
    if (result.balance !== null) {
      channel.balance = result.balance;
      channel.balanceCurrency = result.balanceCurrency;
      channel.balanceUpdatedAt = channel.lastCheckedAt;
      channel.balanceStatus = result.balanceStatus;
    }
    return channel;
  }

  async recordUsage(event: UsageEventInput): Promise<void> {
    this.usage.push({ ...event, createdAt: new Date().toISOString() });
    if (event.channelId) {
      const channel = this.channels.get(event.channelId);
      if (channel) {
        const recent = this.usage.filter((item) => item.channelId === channel.id && isHealthRelevantEvent(item)).slice(-100);
        channel.recentRequestCount = recent.length;
        channel.recentErrorRate = recent.length ? recent.filter((item) => item.statusCode >= 400).length / recent.length : 0;
      }
    }
  }

  async listRequestLogs(filters: RequestLogFilters): Promise<RequestLogPage> {
    const duration = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }[filters.window];
    const clientFilter = filters.client?.trim().toLowerCase();
    const channelFilter = filters.channel?.trim().toLowerCase();
    const modelFilter = filters.model?.trim().toLowerCase();
    const sourceIpFilter = filters.sourceIp?.trim().toLowerCase();
    const recentEvents = this.usage.filter((event) => Date.parse(event.createdAt) >= Date.now() - duration);
    const filterOptions = {
      clients: uniqueSorted(recentEvents.map((event) => event.clientName)),
      channels: uniqueSorted(recentEvents.map((event) => this.channels.get(event.channelId ?? "")?.name ?? "unrouted")),
      models: uniqueSorted(recentEvents.map((event) => event.modelAlias)),
      sourceIps: uniqueSorted(recentEvents.map((event) => event.sourceIp).filter((value): value is string => Boolean(value?.trim()))),
    };
    const matched = recentEvents
      .filter((event) => !clientFilter || event.clientName.toLowerCase().includes(clientFilter))
      .filter((event) => !modelFilter || event.modelAlias.toLowerCase().includes(modelFilter) || (event.upstreamModel ?? "").toLowerCase().includes(modelFilter))
      .filter((event) => !sourceIpFilter || (event.sourceIp ?? "").toLowerCase().includes(sourceIpFilter))
      .filter((event) => !filters.localOnly || isLocalSourceIp(event.sourceIp))
      .filter((event) => {
        if (!channelFilter) return true;
        const channel = this.channels.get(event.channelId ?? "");
        return (channel?.name ?? "unrouted").toLowerCase().includes(channelFilter)
          || (channel?.providerName ?? "").toLowerCase().includes(channelFilter);
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const items = matched.slice(filters.offset, filters.offset + filters.limit).map((event, index) => this.toRequestLogEntry(event, filters.offset + index));
    return {
      items,
      total: matched.length,
      limit: filters.limit,
      offset: filters.offset,
      hasMore: filters.offset + items.length < matched.length,
      filterOptions,
    };
  }

  private toRequestLogEntry(event: UsageEventInput & { createdAt: string }, index: number): RequestLogEntry {
    const channel = this.channels.get(event.channelId ?? "");
    return {
      id: `${event.requestId}-${event.createdAt}-${index}`,
      requestId: event.requestId,
      createdAt: event.createdAt,
      channelId: event.channelId,
      channelName: channel?.name ?? null,
      providerName: channel?.providerName ?? null,
      keyName: channel?.keyName ?? "API Key",
      gatewayKeyName: event.gatewayKeyName ?? null,
      reasoningEffort: event.reasoningEffort ?? null,
      modelAlias: event.modelAlias,
      upstreamModel: event.upstreamModel,
      clientName: event.clientName,
      sourceIp: event.sourceIp ?? null,
      requestKind: event.requestKind,
      endpoint: event.endpoint ?? endpointForKind(event.requestKind),
      statusCode: event.statusCode,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      cachedTokens: event.cachedTokens ?? null,
      costUsd: event.costUsd ?? null,
      latencyMs: event.latencyMs,
      firstByteLatencyMs: event.firstByteLatencyMs ?? null,
      errorType: event.errorType,
      retryCount: event.retryCount,
      streamed: event.streamed,
    };
  }

  async listPlaygroundSessions(limit = 30): Promise<PlaygroundSession[]> {
    return [...this.playgroundSessions.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async getPlaygroundSession(id: string): Promise<PlaygroundSession | null> {
    return this.playgroundSessions.get(id) ?? null;
  }

  async savePlaygroundSession(session: PlaygroundSession): Promise<PlaygroundSession> {
    this.playgroundSessions.set(session.id, session);
    return session;
  }

  async deletePlaygroundSession(id: string): Promise<boolean> {
    return this.playgroundSessions.delete(id);
  }

  async recordChannelFailure(channelId: string, reason: string, failureThreshold: number): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.consecutiveFailures += 1;
    channel.status = channel.consecutiveFailures >= failureThreshold ? "isolated" : "degraded";
    channel.isolationReason = reason;
    if (channel.status === "isolated") channel.cooldownUntil = new Date(Date.now() + 300_000).toISOString();
  }

  async recordChannelSuccess(channelId: string, latencyMs: number): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.enabled) return;
    channel.status = "healthy";
    channel.consecutiveFailures = 0;
    channel.cooldownUntil = null;
    channel.isolationReason = null;
    channel.lastLatencyMs = latencyMs;
  }

  async getPools(): Promise<PoolSummary[]> {
    const grouped = new Map<string, PoolSummary>();
    const latestRequestByAlias = new Map<string, number>();
    for (const event of this.usage) {
      const timestamp = Date.parse(event.createdAt);
      if (!Number.isFinite(timestamp)) continue;
      latestRequestByAlias.set(event.modelAlias, Math.max(latestRequestByAlias.get(event.modelAlias) ?? 0, timestamp));
    }
    for (const route of this.routes.filter((item) => item.enabled)) {
      const channel = this.channels.get(route.channelId);
      if (!channel) continue;
      const routeEvents = this.usage.filter((event) => event.modelAlias === route.alias && event.channelId === channel.id);
      const lastRequestedAt = routeEvents.reduce<string | null>((latest, event) => {
        if (!latest || Date.parse(event.createdAt) > Date.parse(latest)) return event.createdAt;
        return latest;
      }, null);
      const routeEvents1h = routeEvents.filter((event) => isHealthRelevantEvent(event) && Date.parse(event.createdAt) >= Date.now() - 3_600_000);
      const routeHealth = buildPoolHealth(routeEvents);
      const health = buildPoolHealth(this.usage.filter((event) => event.modelAlias === route.alias));
      const events = this.usage.filter((event) => event.modelAlias === route.alias
        && isHealthRelevantEvent(event)
        && Date.parse(event.createdAt) >= Date.now() - 3_600_000);
      const pool = grouped.get(route.alias) ?? {
        alias: route.alias,
        channels: 0,
        healthyChannels: 0,
        totalRequests1h: events.length,
        errorRate1h: events.length ? events.filter((event) => event.statusCode >= 400).length / events.length : 0,
        averageLatencyMs1h: average(events.map((event) => event.latencyMs)),
        ...health,
        routes: [],
      };
      pool.channels += 1;
      if (channel.status === "healthy") pool.healthyChannels += 1;
      pool.routes.push({
        channelId: channel.id,
        channelName: channel.name,
        providerName: channel.providerName,
        upstreamModel: route.upstreamModel,
        status: channel.status,
        priority: channel.priority,
        weight: channel.weight,
        lastRequestedAt,
        conversationLatencyMs: routeEvents1h.length ? average(routeEvents1h.map((event) => event.latencyMs)) : null,
        endpointPingMs: channel.lastLatencyMs,
        health1h: routeHealth.health1h,
        hourlyHealth: routeHealth.hourlyHealth,
        recentHealth: routeHealth.recentHealth,
        health12h: routeHealth.health12h,
        health7d: routeHealth.health7d,
      });
      grouped.set(route.alias, pool);
    }
    for (const pool of grouped.values()) pool.routes.sort(comparePoolRoutesByLastRequest);
    return [...grouped.values()].sort((a, b) => {
      const latestDifference = (latestRequestByAlias.get(b.alias) ?? 0) - (latestRequestByAlias.get(a.alias) ?? 0);
      return latestDifference || a.alias.localeCompare(b.alias, "zh-CN");
    });
  }

  async getUsage(window: "1h" | "24h" | "7d"): Promise<UsageSummary> {
    const duration = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }[window];
    const events = this.usage.filter((event) => Date.parse(event.createdAt) >= Date.now() - duration);
    const successes = events.filter((event) => event.statusCode < 400 || event.errorType === "client_closed_request").length;
    return {
      window,
      totalRequests: events.length,
      successfulRequests: successes,
      errorRate: events.length ? (events.length - successes) / events.length : 0,
      averageLatencyMs: average(events.map((event) => event.latencyMs)),
      promptTokens: sum(events.map((event) => event.promptTokens)),
      completionTokens: sum(events.map((event) => event.completionTokens)),
      byModel: groupUsage(events, (event) => event.modelAlias),
      byChannel: groupUsage(events, (event) => this.channels.get(event.channelId ?? "")?.name ?? "unrouted"),
      byClient: groupUsage(events, (event) => event.clientName),
      byError: groupUsage(
        events.filter((event) => event.errorType !== null && event.errorType !== "client_closed_request"),
        (event) => event.errorType ?? "unknown",
      ),
      timeline: buildTimeline(events, window),
    };
  }

  async getBalances(): Promise<Channel[]> {
    return this.listChannels();
  }

  async listHealthCheckChannels(): Promise<Channel[]> {
    return [...this.channels.values()].filter(
      (channel) => channel.enabled && (!channel.cooldownUntil || Date.parse(channel.cooldownUntil) <= Date.now()),
    );
  }

  async listGatewayKeys(): Promise<GatewayKeySummary[]> {
    return [...this.gatewayKeys.values()]
      .map(({ keyHash: _keyHash, ...summary }) => summary)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async createGatewayKey(name: string, keyHash: string, keyLast4: string): Promise<GatewayKey> {
    const key: GatewayKey = {
      id: randomUUID(),
      name,
      keyHash,
      keyLast4,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.gatewayKeys.set(key.id, key);
    return key;
  }

  async deleteGatewayKey(id: string): Promise<boolean> {
    return this.gatewayKeys.delete(id);
  }

  async hasGatewayKey(keyHash: string): Promise<boolean> {
    return [...this.gatewayKeys.values()].some((key) => key.enabled && key.keyHash === keyHash);
  }

  async findGatewayKey(keyHash: string): Promise<GatewayKeySummary | null> {
    const key = [...this.gatewayKeys.values()].find((item) => item.enabled && item.keyHash === keyHash);
    if (!key) return null;
    key.lastUsedAt = new Date().toISOString();
    const { keyHash: _keyHash, ...summary } = key;
    return summary;
  }

  async getAdminAccount(): Promise<AdminAccount | null> {
    return this.adminAccount;
  }

  async saveAdminAccount(account: AdminAccount): Promise<AdminAccount> {
    this.adminAccount = account;
    return account;
  }

  async recordAdminLogin(record: Omit<AdminLoginRecord, "id">): Promise<AdminLoginRecord> {
    const entry = { id: randomUUID(), ...record };
    this.adminLoginHistory.unshift(entry);
    this.adminLoginHistory.splice(10);
    return entry;
  }

  async listAdminLoginHistory(limit = 10): Promise<AdminLoginRecord[]> {
    return this.adminLoginHistory.slice(0, Math.max(1, Math.min(limit, 10)));
  }

  async close(): Promise<void> {}
}

type PersistedMemoryState = {
  version: 1;
  channels: Channel[];
  routes: ModelRoute[];
  usage: Array<UsageEventInput & { createdAt: string }>;
  gatewayKeys?: GatewayKey[];
  playgroundSessions?: PlaygroundSession[];
  adminAccount?: AdminAccount;
  adminLoginHistory?: AdminLoginRecord[];
};

/** File-backed control-plane storage for local development without PostgreSQL. */
export class PersistentMemoryStore extends MemoryStore {
  private writeQueue = Promise.resolve();

  private constructor(private readonly filePath: string) {
    super();
  }

  static async fromFile(filePath: string, fallbackFilePath?: string): Promise<PersistentMemoryStore> {
    const store = new PersistentMemoryStore(filePath);
    if (await store.load(fallbackFilePath)) await store.persist();
    return store;
  }

  override async importProvider(...args: Parameters<MemoryStore["importProvider"]>) {
    const result = await super.importProvider(...args);
    await this.persist();
    return result;
  }

  override async updateChannel(...args: Parameters<MemoryStore["updateChannel"]>) {
    const result = await super.updateChannel(...args);
    await this.persist();
    return result;
  }

  override async updateChannelBalance(...args: Parameters<MemoryStore["updateChannelBalance"]>) {
    const result = await super.updateChannelBalance(...args);
    await this.persist();
    return result;
  }

  override async reorderChannels(...args: Parameters<MemoryStore["reorderChannels"]>) {
    const result = await super.reorderChannels(...args);
    await this.persist();
    return result;
  }

  override async deleteChannel(...args: Parameters<MemoryStore["deleteChannel"]>) {
    const result = await super.deleteChannel(...args);
    await this.persist();
    return result;
  }

  override async setChannelEnabled(...args: Parameters<MemoryStore["setChannelEnabled"]>) {
    const result = await super.setChannelEnabled(...args);
    await this.persist();
    return result;
  }

  override async saveModelAlias(...args: Parameters<MemoryStore["saveModelAlias"]>) {
    await super.saveModelAlias(...args);
    await this.persist();
  }

  override async applyProbeResult(...args: Parameters<MemoryStore["applyProbeResult"]>) {
    const result = await super.applyProbeResult(...args);
    await this.persist();
    return result;
  }

  override async recordUsage(...args: Parameters<MemoryStore["recordUsage"]>) {
    await super.recordUsage(...args);
    await this.persist();
  }

  override async savePlaygroundSession(...args: Parameters<MemoryStore["savePlaygroundSession"]>) {
    const result = await super.savePlaygroundSession(...args);
    await this.persist();
    return result;
  }

  override async deletePlaygroundSession(...args: Parameters<MemoryStore["deletePlaygroundSession"]>) {
    const result = await super.deletePlaygroundSession(...args);
    await this.persist();
    return result;
  }

  override async recordChannelFailure(...args: Parameters<MemoryStore["recordChannelFailure"]>) {
    await super.recordChannelFailure(...args);
    await this.persist();
  }

  override async recordChannelSuccess(...args: Parameters<MemoryStore["recordChannelSuccess"]>) {
    await super.recordChannelSuccess(...args);
    await this.persist();
  }

  override async createGatewayKey(...args: Parameters<MemoryStore["createGatewayKey"]>) {
    const result = await super.createGatewayKey(...args);
    await this.persist();
    return result;
  }

  override async saveAdminAccount(...args: Parameters<MemoryStore["saveAdminAccount"]>) {
    const result = await super.saveAdminAccount(...args);
    await this.persist();
    return result;
  }

  override async recordAdminLogin(...args: Parameters<MemoryStore["recordAdminLogin"]>) {
    const result = await super.recordAdminLogin(...args);
    await this.persist();
    return result;
  }

  override async deleteGatewayKey(...args: Parameters<MemoryStore["deleteGatewayKey"]>) {
    const result = await super.deleteGatewayKey(...args);
    await this.persist();
    return result;
  }

  override async close(): Promise<void> {
    await this.persist();
  }

  private async load(fallbackFilePath?: string): Promise<boolean> {
    let sourcePath = this.filePath;
    try {
      const raw = await readFile(sourcePath, "utf8");
      const state = JSON.parse(raw) as Partial<PersistedMemoryState>;
      if (state.version !== 1 || !Array.isArray(state.channels) || !Array.isArray(state.routes) || !Array.isArray(state.usage)) {
        throw new Error("Unsupported autoAPI local state format");
      }
      for (const channel of state.channels) {
        if (channel && typeof channel.id === "string") this.channels.set(channel.id, {
          ...channel,
          faviconUrl: channel.faviconUrl ?? null,
          balanceUpdatedAt: channel.balanceUpdatedAt ?? (channel.balance !== null ? channel.lastCheckedAt : null),
        });
      }
      this.routes.push(...state.routes.filter((route) => route && typeof route.id === "string"));
      this.usage.push(...state.usage.filter((event) => event && typeof event.createdAt === "string"));
      for (const channel of this.channels.values()) this.refreshRecentChannelStats(channel);
      for (const key of state.gatewayKeys ?? []) {
        if (key && typeof key.id === "string" && typeof key.keyHash === "string") this.gatewayKeys.set(key.id, key);
      }
      for (const session of state.playgroundSessions ?? []) {
        if (session && typeof session.id === "string" && Array.isArray(session.messages)) this.playgroundSessions.set(session.id, session);
      }
      if (state.adminAccount && typeof state.adminAccount.username === "string" && typeof state.adminAccount.passwordHash === "string") this.adminAccount = state.adminAccount;
      this.adminLoginHistory.push(...(state.adminLoginHistory ?? []).filter((record) => record && typeof record.id === "string").slice(0, 10));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallbackFilePath) {
        sourcePath = fallbackFilePath;
        try {
          const raw = await readFile(sourcePath, "utf8");
          const state = JSON.parse(raw) as Partial<PersistedMemoryState>;
          if (state.version !== 1 || !Array.isArray(state.channels) || !Array.isArray(state.routes) || !Array.isArray(state.usage)) {
            throw new Error("Unsupported autoAPI local state format");
          }
          for (const channel of state.channels) {
            if (channel && typeof channel.id === "string") this.channels.set(channel.id, { ...channel, faviconUrl: channel.faviconUrl ?? null });
          }
          this.routes.push(...state.routes.filter((route) => route && typeof route.id === "string"));
          this.usage.push(...state.usage.filter((event) => event && typeof event.createdAt === "string"));
          for (const channel of this.channels.values()) this.refreshRecentChannelStats(channel);
          for (const key of state.gatewayKeys ?? []) {
            if (key && typeof key.id === "string" && typeof key.keyHash === "string") this.gatewayKeys.set(key.id, key);
          }
          for (const session of state.playgroundSessions ?? []) {
            if (session && typeof session.id === "string" && Array.isArray(session.messages)) this.playgroundSessions.set(session.id, session);
          }
          if (state.adminAccount && typeof state.adminAccount.username === "string" && typeof state.adminAccount.passwordHash === "string") this.adminAccount = state.adminAccount;
          this.adminLoginHistory.push(...(state.adminLoginHistory ?? []).filter((record) => record && typeof record.id === "string").slice(0, 10));
          return true;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw new Error(`Unable to load autoAPI local state: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        }
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(`Unable to load autoAPI local state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): Promise<void> {
    const state: PersistedMemoryState = {
      version: 1,
      channels: [...this.channels.values()],
      routes: [...this.routes],
      usage: [...this.usage],
      gatewayKeys: [...this.gatewayKeys.values()],
      playgroundSessions: [...this.playgroundSessions.values()],
      ...(this.adminAccount ? { adminAccount: this.adminAccount } : {}),
      adminLoginHistory: [...this.adminLoginHistory],
    };
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
      await rename(temporaryPath, this.filePath);
    };
    this.writeQueue = this.writeQueue.catch(() => undefined).then(write);
    return this.writeQueue;
  }

  private refreshRecentChannelStats(channel: Channel): void {
    const recent = this.usage.filter((item) => item.channelId === channel.id && isHealthRelevantEvent(item)).slice(-100);
    channel.recentRequestCount = recent.length;
    channel.recentErrorRate = recent.length ? recent.filter((item) => item.statusCode >= 400).length / recent.length : 0;
  }
}

function resetChannelHealth(channel: Channel) {
  channel.consecutiveFailures = 0;
  channel.cooldownUntil = null;
  channel.isolationReason = null;
  channel.lastCheckedAt = null;
  channel.lastLatencyMs = null;
  channel.status = "pending";
}

function getBalanceStatus(balance: number | null, minBalance: number | null): Channel["balanceStatus"] {
  if (balance === null) return "unknown";
  if (balance <= 0) return "exhausted";
  if (minBalance !== null && balance < minBalance) return "low";
  return "ok";
}

function compareChannelsByHealth(a: Channel, b: Channel): number {
  const availabilityDifference = channelAvailabilityRank(a) - channelAvailabilityRank(b);
  if (availabilityDifference !== 0) return availabilityDifference;

  const aHasRequests = a.recentRequestCount > 0;
  const bHasRequests = b.recentRequestCount > 0;
  if (aHasRequests !== bHasRequests) return aHasRequests ? -1 : 1;

  if (aHasRequests && bHasRequests) {
    const healthDifference = channelHealthPercent(b) - channelHealthPercent(a);
    if (healthDifference !== 0) return healthDifference;
    if (a.recentRequestCount !== b.recentRequestCount) return b.recentRequestCount - a.recentRequestCount;
  }

  const latencyDifference = (a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER);
  if (latencyDifference !== 0) return latencyDifference;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function channelAvailabilityRank(channel: Channel): number {
  if (!channel.enabled || channel.status === "disabled" || channel.status === "isolated") return 2;
  return channel.status === "degraded" ? 1 : 0;
}

function channelHealthPercent(channel: Channel): number {
  return 1 - Math.min(1, Math.max(0, Number.isFinite(channel.recentErrorRate) ? channel.recentErrorRate : 1));
}

function comparePoolRoutesByLastRequest(a: PoolSummary["routes"][number], b: PoolSummary["routes"][number]): number {
  const lastRequestDifference = (Date.parse(b.lastRequestedAt ?? "") || 0) - (Date.parse(a.lastRequestedAt ?? "") || 0);
  if (lastRequestDifference !== 0) return lastRequestDifference;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.channelName.localeCompare(b.channelName, "zh-CN");
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return values.length ? Math.round(sum(values) / values.length) : 0;
}

function groupUsage(
  events: Array<UsageEventInput & { createdAt: string }>,
  getName: (event: UsageEventInput) => string,
) {
  const groups = new Map<string, UsageEventInput[]>();
  for (const event of events) {
    const name = getName(event);
    groups.set(name, [...(groups.get(name) ?? []), event]);
  }
  return [...groups.entries()].map(([name, items]) => ({
    name,
    requests: items.length,
    errors: items.filter((event) => event.statusCode >= 400 && event.errorType !== "client_closed_request").length,
    latencyMs: average(items.map((event) => event.latencyMs)),
  }));
}

function buildTimeline(events: Array<UsageEventInput & { createdAt: string }>, window: "1h" | "24h" | "7d") {
  const bucketMs = window === "1h" ? 300_000 : window === "24h" ? 3_600_000 : 86_400_000;
  const groups = new Map<number, { requests: number; errors: number }>();
  for (const event of events) {
    const bucket = Math.floor(Date.parse(event.createdAt) / bucketMs) * bucketMs;
    const current = groups.get(bucket) ?? { requests: 0, errors: 0 };
    current.requests += 1;
    if (event.statusCode >= 400 && event.errorType !== "client_closed_request") current.errors += 1;
    groups.set(bucket, current);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, values]) => ({ bucket: new Date(bucket).toISOString(), ...values }));
}

function endpointForKind(kind: UsageEventInput["requestKind"]): string {
  return kind === "responses" ? "/responses" : kind === "messages" ? "/messages" : "/chat/completions";
}

function isLocalSourceIp(sourceIp: string | null | undefined): boolean {
  return sourceIp === "127.0.0.1" || sourceIp === "::1" || sourceIp === "::ffff:127.0.0.1";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
