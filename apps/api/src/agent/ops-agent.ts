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
    for (const channel of await this.options.store.listChannels()) {
      if (normalizeBaseUrl(channel.baseUrl) !== normalizedBaseUrl) continue;
      if (this.options.secrets.decrypt(channel.keyCiphertext) === apiKey) {
        throw new ChannelImportError("相同 Base URL 和 API Key 已经在渠道池中", 409, "conflict");
      }
    }

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
    const existingChannels = await this.options.store.listChannels();
    for (const channel of existingChannels) {
      if (normalizeBaseUrl(channel.baseUrl) !== pending.baseUrl) continue;
      const existingKey = this.options.secrets.decrypt(channel.keyCiphertext);
      if (existingKey === apiKey) {
        throw new ChannelImportError("相同 Base URL 和 API Key 已经在渠道池中", 409, "conflict");
      }
    }

    const requestedModels = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
    const models = pending.models.length > 0 ? requestedModels : [];
    if (pending.models.length > 0 && models.some((model) => !pending.models.includes(model))) {
      throw new ChannelImportError("所选模型不在该站点返回的模型列表中", 422, "validation_failed");
    }

    // A candidate is single-use. Delete it before writing the channel so a retry
    // cannot accidentally create a duplicate after a partially completed request.
    this.pendingChannelImports.delete(input.candidateId);
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
    return { channel: channel ?? imported.channel, probe: null };
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
    let result: ProbeResult;
    if (channel.protocol === "auto") {
      const attempts: ProbeResult[] = [];
      for (const adapter of this.options.registry.detectionOrder()) {
        const candidate = await adapter.probe(channel, key, this.options.timeoutMs);
        attempts.push(candidate);
        if (candidate.ok) {
          result = candidate;
          await this.options.store.applyProbeResult(channelId, result, this.options.failureThreshold);
          return result;
        }
      }
      result = attempts.at(-1) ?? failedProbe("No protocol adapters are configured");
      result = { ...result, error: attempts.map((item) => `${item.protocol}: ${item.error ?? "failed"}`).join("; ") };
    } else {
      result = await this.options.registry.forChannel(channel.protocol).probe(channel, key, this.options.timeoutMs);
    }
    await this.options.store.applyProbeResult(channelId, result, this.options.failureThreshold);
    return result;
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

function redactCredential(message: string, apiKey: string): string {
  return message
    .replaceAll(apiKey, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .slice(0, 500);
}
