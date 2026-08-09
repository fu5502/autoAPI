import type { GatewayStore } from "../domain/store.js";
import { randomUUID } from "node:crypto";
import type { Channel, ChannelModelDiscoveryInput, ChannelUpdateInput, ModelDiscoveryResult, ProbeResult, Protocol, ProviderImportInput, ProviderProbeInput } from "../domain/types.js";
import type { SecretBox } from "../security/secret-box.js";
import type { AdapterRegistry } from "../gateway/adapter.js";
import { GatewayError } from "../gateway/errors.js";

export interface OpsAgentOptions {
  store: GatewayStore;
  registry: AdapterRegistry;
  secrets: SecretBox;
  timeoutMs: number;
  failureThreshold: number;
  intervalMs: number;
}

export interface ChannelImportPreview {
  candidateId: string;
  siteName: string;
  keyName: string;
  baseUrl: string;
  protocol: Protocol;
  models: string[];
  keyLast4: string;
  validation: {
    status: "not_probed";
    ok: boolean;
    chatOk: boolean;
    streamOk: boolean;
    latencyMs: number;
    balance: number | null;
    balanceCurrency: string | null;
    balanceStatus: ProbeResult["balanceStatus"];
  };
  matchedChannel: {
    id: string;
    name: string;
    baseUrl: string;
    keyName: string;
    keyLast4: string;
    models: string[];
  } | null;
  expiresAt: string;
}

interface PendingChannelImport {
  candidateId: string;
  siteId: number;
  siteName: string;
  keyName: string;
  baseUrl: string;
  protocol: Protocol;
  models: string[];
  keyCiphertext: string;
  keyLast4: string;
  matchedChannelId: string | null;
  expiresAtMs: number;
}

export class ChannelImportError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 410 | 422 | 502,
    readonly errorType: "unsupported" | "not_found" | "conflict" | "expired" | "validation_failed" = "validation_failed",
  ) {
    super(message);
    this.name = "ChannelImportError";
  }
}

export class OpsAgent {
  private timer: NodeJS.Timeout | null = null;
  private sweepRunning = false;
  private readonly pendingChannelImports = new Map<string, PendingChannelImport>();

  constructor(private readonly options: OpsAgentOptions) {}

  async onboard(input: ProviderImportInput) {
    const encrypted = this.options.secrets.encrypt(input.apiKey);
    return this.options.store.importProvider(input, encrypted, input.apiKey.slice(-4), input.keyName);
  }

  async prepareChannelImport(input: {
    siteId: number;
    siteName: string;
    keyName?: string;
    baseUrl: string;
    apiKey: string;
    protocol: Protocol;
  }): Promise<ChannelImportPreview> {
    this.removeExpiredChannelImports();
    const apiKey = input.apiKey.trim();
    if (!isOfficialApiKey(apiKey)) {
      throw new ChannelImportError("只接受站点官方 API Key，登录会话 Token 不能导入渠道池", 422, "unsupported");
    }

    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    const matchedChannel = findDomainMatch(await this.options.store.listChannels(), normalizedBaseUrl, apiKey, this.options.secrets);

    const candidateId = randomUUID();
    const expiresAtMs = Date.now() + 10 * 60_000;
    this.pendingChannelImports.set(candidateId, {
      candidateId,
      siteId: input.siteId,
      siteName: input.siteName,
      keyName: input.keyName?.trim() || `API Key 尾号 ${apiKey.slice(-4)}`,
      baseUrl: normalizedBaseUrl,
      protocol: input.protocol,
      models: [],
      keyCiphertext: this.options.secrets.encrypt(apiKey),
      keyLast4: apiKey.slice(-4),
      matchedChannelId: matchedChannel?.id ?? null,
      expiresAtMs,
    });
    return {
      candidateId,
      siteName: input.siteName,
      keyName: input.keyName?.trim() || `API Key 尾号 ${apiKey.slice(-4)}`,
      baseUrl: normalizedBaseUrl,
      protocol: input.protocol,
      models: [],
      keyLast4: apiKey.slice(-4),
      validation: {
        status: "not_probed",
        ok: false,
        chatOk: false,
        streamOk: false,
        latencyMs: 0,
        balance: null,
        balanceCurrency: null,
        balanceStatus: "unknown",
      },
      matchedChannel: matchedChannel ? sanitizeMatchedChannel(matchedChannel) : null,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async discoverChannelImportModels(input: { candidateId: string; siteId: number }): Promise<ModelDiscoveryResult> {
    this.removeExpiredChannelImports();
    const pending = this.pendingChannelImports.get(input.candidateId);
    if (!pending) throw new ChannelImportError("导入候选已过期或不存在，请重新提取", 410, "expired");
    if (pending.siteId !== input.siteId) throw new ChannelImportError("导入候选与当前站点不匹配", 404, "not_found");

    const apiKey = this.options.secrets.decrypt(pending.keyCiphertext);
    try {
      const result = await this.discoverModels({
        baseUrl: pending.baseUrl,
        apiKey,
        protocol: pending.protocol,
        models: pending.models,
      });
      pending.models = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))];
      if (result.protocol !== "auto") pending.protocol = result.protocol;
      return result;
    } catch (error) {
      throw new ChannelImportError(
        redactCredential(error instanceof Error ? error.message : "模型列表获取失败", apiKey),
        502,
        "validation_failed",
      );
    }
  }

  async confirmChannelImport(input: {
    candidateId: string;
    siteId: number;
    name: string;
    models: string[];
    priority: number;
    weight: number;
    tags: string[];
  }) {
    this.removeExpiredChannelImports();
    const pending = this.pendingChannelImports.get(input.candidateId);
    if (!pending) throw new ChannelImportError("导入候选已过期或不存在，请重新提取并验证", 410, "expired");
    if (pending.siteId !== input.siteId) throw new ChannelImportError("导入候选与当前站点不匹配", 404, "not_found");

    const apiKey = this.options.secrets.decrypt(pending.keyCiphertext);
    const matchedChannel = pending.matchedChannelId
      ? await this.options.store.getChannel(pending.matchedChannelId)
      : null;

    const requestedModels = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
    const models = pending.models.length > 0 ? requestedModels : matchedChannel?.models ?? [];
    if (pending.models.length > 0 && models.some((model) => !pending.models.includes(model))) {
      throw new ChannelImportError("所选模型不在该站点返回的模型列表中", 422, "validation_failed");
    }

    // A candidate is single-use. Delete it before writing the channel so a retry
    // cannot accidentally create a duplicate after a partially completed request.
    this.pendingChannelImports.delete(input.candidateId);
    if (matchedChannel) {
      const updated = await this.updateChannel(matchedChannel.id, {
        name: input.name.trim(),
        keyName: pending.keyName,
        apiKey,
        baseUrl: pending.baseUrl,
        protocol: pending.protocol,
        models,
        priority: input.priority,
        weight: input.weight,
        minBalance: matchedChannel.minBalance,
        balance: matchedChannel.balance,
        balanceCurrency: matchedChannel.balanceCurrency,
        tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
        enabled: matchedChannel.enabled,
      });
      if (!updated) throw new ChannelImportError("匹配到的渠道已不存在，请重新导入", 404, "not_found");
      return { channel: updated, probe: null, action: "updated" as const };
    }
    const imported = await this.onboard({
      name: input.name.trim(),
      channelName: input.name.trim(),
      keyName: pending.keyName,
      baseUrl: pending.baseUrl,
      apiKey,
      protocol: pending.protocol,
      models,
      priority: input.priority,
      weight: input.weight,
      tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    });
    const channel = await this.options.store.getChannel(imported.channel.id);
    return { channel: channel ?? imported.channel, probe: null, action: "created" as const };
  }

  async discoverModels(input: ProviderProbeInput): Promise<ModelDiscoveryResult> {
    const channel = createProbeChannel(input);
    const key = input.apiKey;
    const failures: string[] = [];
    const adapters = input.protocol === "auto"
      ? this.options.registry.detectionOrder()
      : [this.options.registry.forChannel(input.protocol)];

    for (const adapter of adapters) {
      try {
        const models = await adapter.listModels(channel, key, this.options.timeoutMs);
        return { protocol: input.protocol === "auto" ? adapter.protocol : input.protocol, models, error: null };
      } catch (error) {
        failures.push(`${adapter.protocol}: ${redactCredential(error instanceof Error ? error.message : "模型列表获取失败", key)}`);
      }
    }

    return {
      protocol: input.protocol,
      models: input.models,
      error: failures.join("；") || "未能获取模型列表",
    };
  }

  async discoverChannelModels(channelId: string, input: ChannelModelDiscoveryInput): Promise<ModelDiscoveryResult> {
    const channel = await this.options.store.getChannel(channelId);
    if (!channel) throw new GatewayError("Channel not found", 404, "not_found");
    const apiKey = input.apiKey?.trim()
      ? input.apiKey.trim()
      : this.options.secrets.decrypt(channel.keyCiphertext);
    return this.discoverModels({
      baseUrl: input.baseUrl?.trim() || channel.baseUrl,
      apiKey,
      protocol: input.protocol ?? channel.protocol,
      models: channel.models,
    });
  }

  async updateChannel(id: string, input: ChannelUpdateInput) {
    const encrypted = input.apiKey ? this.options.secrets.encrypt(input.apiKey) : undefined;
    const updated = await this.options.store.updateChannel(id, input, encrypted, input.apiKey?.slice(-4), input.keyName);
    if (!updated) throw new GatewayError("Channel not found", 404, "not_found");
    return updated;
  }

  async probeChannel(channelId: string): Promise<ProbeResult> {
    const channel = await this.options.store.getChannel(channelId);
    if (!channel) throw new GatewayError("Channel not found", 404, "not_found");
    const key = this.options.secrets.decrypt(channel.keyCiphertext);
    const startedAt = Date.now();
    let result: ProbeResult;
    if (channel.protocol === "auto") {
      const attempts: ProbeResult[] = [];
      for (const adapter of this.options.registry.detectionOrder()) {
        const candidate = await adapter.probe(channel, key, this.options.timeoutMs);
        attempts.push(candidate);
        if (candidate.ok) {
          result = candidate;
          await this.options.store.applyProbeResult(channelId, result, this.options.failureThreshold);
          await this.recordProbeUsage(channel, result, Date.now() - startedAt);
          return result;
        }
      }
      result = attempts.at(-1) ?? failedProbe("No protocol adapters are configured");
      result = { ...result, error: attempts.map((item) => `${item.protocol}: ${item.error ?? "failed"}`).join("; ") };
    } else {
      result = await this.options.registry.forChannel(channel.protocol).probe(channel, key, this.options.timeoutMs);
    }
    await this.options.store.applyProbeResult(channelId, result, this.options.failureThreshold);
    await this.recordProbeUsage(channel, result, Date.now() - startedAt);
    return result;
  }

  private async recordProbeUsage(channel: Channel, result: ProbeResult, latencyMs: number): Promise<void> {
    const requestKind = result.protocol === "claude" ? "messages" : "chat";
    try {
      await this.options.store.recordUsage({
        requestId: randomUUID(),
        channelId: channel.id,
        modelAlias: result.probedModel ?? channel.models[0] ?? "channel-probe",
        upstreamModel: result.probedModel ?? channel.models[0] ?? null,
        clientName: "channel-probe",
        requestKind,
        statusCode: result.ok ? 200 : 502,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        errorType: result.ok ? null : result.errorType ?? "probe_failed",
        retryCount: 0,
        streamed: result.streamOk,
        endpoint: result.protocol === "claude"
          ? "/v1/messages"
          : result.protocol === "gemini"
            ? "/v1beta/models/:generateContent"
            : "/v1/chat/completions",
        sourceIp: null,
        gatewayKeyName: null,
        reasoningEffort: null,
        cachedTokens: null,
        firstByteLatencyMs: null,
      });
    } catch {
      // Recording a probe log must never break the probe result itself.
    }
  }

  async runHealthSweep(): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      const channels = await this.options.store.listHealthCheckChannels();
      for (const channel of channels) {
        await this.probeChannel(channel.id).catch(() => undefined);
      }
    } finally {
      this.sweepRunning = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runHealthSweep(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private removeExpiredChannelImports() {
    const now = Date.now();
    for (const [candidateId, pending] of this.pendingChannelImports) {
      if (pending.expiresAtMs <= now) this.pendingChannelImports.delete(candidateId);
    }
  }
}

function failedProbe(error: string): ProbeResult {
  return {
    ok: false,
    protocol: "openai",
    models: [],
    latencyMs: 0,
    chatOk: false,
    streamOk: false,
    balance: null,
    balanceCurrency: null,
    balanceStatus: "unknown",
    error,
  };
}

function createProbeChannel(input: ProviderProbeInput): Channel {
  return {
    id: randomUUID(),
    providerId: randomUUID(),
    providerName: "临时探测渠道",
    name: "临时探测渠道",
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    faviconUrl: null,
    protocol: input.protocol,
    keyCiphertext: "",
    keyLast4: input.apiKey.slice(-4),
    status: "pending",
    enabled: true,
    priority: 0,
    weight: 1,
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
    models: input.models,
    tags: [],
    createdAt: new Date().toISOString(),
  };
}

export function isOfficialApiKey(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length > 512) return false;
  if (candidate.startsWith("sk-")) {
    if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(candidate)) return false;
  } else {
    if (candidate.length < 16 || !/^[A-Za-z0-9][A-Za-z0-9_./:+~=-]*$/.test(candidate)) return false;
  }
  if (/^(?:eyJ|Bearer\s|access[_-]?token|refresh[_-]?token|session|cookie)/i.test(candidate)) return false;
  if (candidate.split(".").length === 3) return false;
  if (/^(?:sk-)?(?:\.\.\.|•{2,}|\*{2,})/i.test(candidate)) return false;
  if (/^(?:sk-)?[A-Za-z0-9_-]{0,8}(?:\.\.\.|•{2,}|\*{2,})/i.test(candidate)) return false;
  return true;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function findDomainMatch(channels: Channel[], baseUrl: string, apiKey: string, secrets: SecretBox): Channel | null {
  const targetHost = channelHost(baseUrl);
  if (!targetHost) return null;
  const matches = channels.filter((channel) => channelHost(channel.baseUrl) === targetHost);
  if (!matches.length) return null;
  const exactKey = matches.find((channel) => {
    try {
      return secrets.decrypt(channel.keyCiphertext) === apiKey;
    } catch {
      return false;
    }
  });
  if (exactKey) return exactKey;
  return matches.find((channel) => normalizeBaseUrl(channel.baseUrl) === baseUrl) ?? matches[0] ?? null;
}

function channelHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function sanitizeMatchedChannel(channel: Channel) {
  return {
    id: channel.id,
    name: channel.name,
    baseUrl: channel.baseUrl,
    keyName: channel.keyName ?? "API Key",
    keyLast4: channel.keyLast4,
    models: channel.models,
  };
}

function redactCredential(message: string, apiKey: string): string {
  return message
    .replaceAll(apiKey, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .slice(0, 500);
}
