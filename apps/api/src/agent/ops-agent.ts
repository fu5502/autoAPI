import type { GatewayStore } from "../domain/store.js";
import { randomUUID } from "node:crypto";
import type { Channel, ChannelModelDiscoveryInput, ChannelUpdateInput, ModelDiscoveryResult, ProbeResult, ProviderImportInput, ProviderProbeInput } from "../domain/types.js";
import type { SecretBox } from "../security/secret-box.js";
import type { AdapterRegistry } from "../gateway/adapter.js";

export interface OpsAgentOptions {
  store: GatewayStore;
  registry: AdapterRegistry;
  secrets: SecretBox;
  timeoutMs: number;
  failureThreshold: number;
  intervalMs: number;
}

export class OpsAgent {
  private timer: NodeJS.Timeout | null = null;
  private sweepRunning = false;

  constructor(private readonly options: OpsAgentOptions) {}

  async onboard(input: ProviderImportInput) {
    const encrypted = this.options.secrets.encrypt(input.apiKey);
    return this.options.store.importProvider(input, encrypted, input.apiKey.slice(-4));
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
        failures.push(`${adapter.protocol}: ${error instanceof Error ? error.message : "模型列表获取失败"}`);
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
    if (!channel) throw new Error("Channel not found");
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
    const updated = await this.options.store.updateChannel(id, input, encrypted, input.apiKey?.slice(-4));
    if (!updated) throw new Error("Channel not found");
    return updated;
  }

  async probeChannel(channelId: string): Promise<ProbeResult> {
    const channel = await this.options.store.getChannel(channelId);
    if (!channel) throw new Error("Channel not found");
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
    recentErrorRate: 0,
    models: input.models,
    tags: [],
    createdAt: new Date().toISOString(),
  };
}
