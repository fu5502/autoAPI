import type { Channel, GatewayRequest, ProbeResult, Protocol, UpstreamResult } from "../domain/types.js";
import type { UpstreamError } from "./errors.js";

export interface AdapterUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
}

/**
 * 上游在 HTTP 200 下仍以"成功响应"形式返回的拒答/拦截信号（典型：content_filter 内容审核）。
 * autoAPI 默认把这些当成普通成功记录（usage 为 0、errorType 空白），导致后台看不到真实原因。
 */
export interface ModerationInfo {
  errorType: string;
  reason: string;
}

export interface AdapterAttempt {
  result: UpstreamResult;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | null;
  firstByteLatencyMs?: number | null;
  streamUsage?: Promise<AdapterUsage>;
  streamError?: Promise<UpstreamError | null>;
  moderation?: Promise<ModerationInfo | null>;
}

export interface UpstreamAdapter {
  readonly protocol: "openai" | "claude" | "gemini";
  supports(request: GatewayRequest): boolean;
  listModels(channel: Channel, apiKey: string, timeoutMs: number): Promise<string[]>;
  execute(
    channel: Channel,
    apiKey: string,
    request: GatewayRequest,
    upstreamModel: string,
    timeoutMs: number,
  ): Promise<AdapterAttempt>;
  probe(channel: Channel, apiKey: string, timeoutMs: number): Promise<ProbeResult>;
}

export class AdapterRegistry {
  private readonly byProtocol: Record<"openai" | "claude" | "gemini", UpstreamAdapter>;

  constructor(adapters: UpstreamAdapter[]) {
    this.byProtocol = Object.fromEntries(adapters.map((adapter) => [adapter.protocol, adapter])) as typeof this.byProtocol;
  }

  forChannel(protocol: Protocol): UpstreamAdapter {
    const wire = protocol === "claude" ? "claude" : protocol === "gemini" ? "gemini" : "openai";
    const adapter = this.byProtocol[wire];
    if (!adapter) throw new Error(`No adapter registered for ${wire}`);
    return adapter;
  }

  detectionOrder(): UpstreamAdapter[] {
    return [this.byProtocol.openai, this.byProtocol.claude, this.byProtocol.gemini].filter(Boolean);
  }
}
