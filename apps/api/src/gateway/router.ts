import type { GatewayStore } from "../domain/store.js";
import type { GatewayRequest, RoutingCandidate, UpstreamResult } from "../domain/types.js";
import type { RuntimeState } from "../runtime/runtime-state.js";
import type { SecretBox } from "../security/secret-box.js";
import type { AdapterRegistry } from "./adapter.js";
import { GatewayError, toUpstreamError } from "./errors.js";
import { eligibleCandidates, orderCandidates } from "./selector.js";

export interface DirectExecution {
  result: UpstreamResult;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  channelId: string;
  upstreamModel: string;
}

export interface GatewayRouterOptions {
  store: GatewayStore;
  registry: AdapterRegistry;
  secrets: SecretBox;
  runtime: RuntimeState;
  timeoutMs: number;
  failureThreshold: number;
}

export class GatewayRouter {
  constructor(private readonly options: GatewayRouterOptions) {}

  async execute(request: GatewayRequest): Promise<UpstreamResult> {
    const startedAt = Date.now();
    const candidates = eligibleCandidates(
      await this.options.store.listRoutingCandidates(request.model),
      request,
      this.options.registry,
    );
    if (candidates.length === 0) {
      await this.recordFailure(request, null, null, 0, 503, "no_eligible_channel", startedAt);
      throw new GatewayError(`No eligible channel for model ${request.model}`, 503, "no_eligible_channel");
    }
    const counter = await this.options.runtime.nextCounter(request.model);
    const attempts = orderCandidates(candidates, counter);
    let lastError: ReturnType<typeof toUpstreamError> | null = null;
    let attemptedChannels = 0;
    for (let index = 0; index < attempts.length; index += 1) {
      const candidate = await this.getCurrentEligibleCandidate(attempts[index]!, request);
      if (!candidate) continue;
      const retryCount = attemptedChannels;
      attemptedChannels += 1;
      try {
        const adapter = this.options.registry.forChannel(candidate.channel.protocol);
        const apiKey = this.options.secrets.decrypt(candidate.channel.keyCiphertext);
        const attempt = await adapter.execute(
          candidate.channel,
          apiKey,
          request,
          candidate.upstreamModel,
          this.options.timeoutMs,
        );
        const latencyMs = Date.now() - startedAt;
        await this.options.store.recordChannelSuccess(candidate.channel.id, latencyMs);
        await this.options.store.recordUsage({
          requestId: request.requestId,
          channelId: candidate.channel.id,
          modelAlias: request.model,
          upstreamModel: candidate.upstreamModel,
          clientName: request.clientName,
          requestKind: request.kind,
          statusCode: attempt.result.status,
          promptTokens: attempt.promptTokens,
          completionTokens: attempt.completionTokens,
          latencyMs,
          errorType: null,
          retryCount,
          streamed: request.stream,
          endpoint: request.endpoint ?? null,
          sourceIp: request.sourceIp ?? null,
        });
        return attempt.result;
      } catch (error) {
        lastError = toUpstreamError(error);
        await this.options.store.recordChannelFailure(
          candidate.channel.id,
          lastError.errorType,
          this.options.failureThreshold,
        );
        await this.recordFailure(
          request,
          candidate.channel.id,
          candidate.upstreamModel,
          retryCount,
          lastError.statusCode,
          lastError.errorType,
          startedAt,
        );
        if (!lastError.retryable) {
          throw new GatewayError(lastError.message, lastError.statusCode, lastError.errorType, lastError);
        }
      }
    }
    if (attemptedChannels === 0) {
      await this.recordFailure(request, null, null, 0, 503, "no_eligible_channel", startedAt);
      throw new GatewayError(`No eligible channel for model ${request.model}`, 503, "no_eligible_channel");
    }
    throw new GatewayError(
      lastError?.message ?? "All upstream channels failed",
      lastError?.statusCode ?? 502,
      "all_channels_failed",
      lastError ?? undefined,
    );
  }

  private async getCurrentEligibleCandidate(candidate: RoutingCandidate, request: GatewayRequest): Promise<RoutingCandidate | null> {
    const channel = await this.options.store.getChannel(candidate.channel.id);
    if (!channel) return null;
    return eligibleCandidates([{ channel, upstreamModel: candidate.upstreamModel }], request, this.options.registry)[0] ?? null;
  }

  async executeDirect(request: GatewayRequest, channelId: string, upstreamModel: string): Promise<DirectExecution> {
    const channel = await this.options.store.getChannel(channelId);
    if (!channel) throw new GatewayError("Channel not found", 404, "not_found");
    if (!channel.enabled || channel.status === "disabled") {
      throw new GatewayError("Channel is disabled", 409, "channel_disabled");
    }
    if (!channel.models.includes(upstreamModel)) {
      throw new GatewayError("Selected model is not configured for this channel", 400, "model_not_configured");
    }

    const adapter = this.options.registry.forChannel(channel.protocol);
    if (!adapter.supports(request)) {
      throw new GatewayError("Selected channel protocol does not support this test request", 400, "unsupported_protocol");
    }

    const startedAt = Date.now();
    try {
      const apiKey = this.options.secrets.decrypt(channel.keyCiphertext);
      const attempt = await adapter.execute(channel, apiKey, request, upstreamModel, this.options.timeoutMs);
      const latencyMs = Date.now() - startedAt;
      await this.options.store.recordChannelSuccess(channel.id, latencyMs);
      await this.options.store.recordUsage({
        requestId: request.requestId,
        channelId: channel.id,
        modelAlias: request.model,
        upstreamModel,
        clientName: request.clientName,
        requestKind: request.kind,
        statusCode: attempt.result.status,
        promptTokens: attempt.promptTokens,
        completionTokens: attempt.completionTokens,
        latencyMs,
        errorType: null,
        retryCount: 0,
        streamed: request.stream,
        endpoint: request.endpoint ?? null,
        sourceIp: request.sourceIp ?? null,
      });
      return { ...attempt, latencyMs, channelId: channel.id, upstreamModel };
    } catch (error) {
      const upstreamError = toUpstreamError(error);
      await this.options.store.recordChannelFailure(channel.id, upstreamError.errorType, this.options.failureThreshold);
      await this.options.store.recordUsage({
        requestId: request.requestId,
        channelId: channel.id,
        modelAlias: request.model,
        upstreamModel,
        clientName: request.clientName,
        requestKind: request.kind,
        statusCode: upstreamError.statusCode,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - startedAt,
        errorType: upstreamError.errorType,
        retryCount: 0,
        streamed: request.stream,
        endpoint: request.endpoint ?? null,
        sourceIp: request.sourceIp ?? null,
      });
      throw new GatewayError(upstreamError.message, upstreamError.statusCode, upstreamError.errorType, upstreamError);
    }
  }

  private async recordFailure(
    request: GatewayRequest,
    channelId: string | null,
    upstreamModel: string | null,
    retryCount: number,
    statusCode: number,
    errorType: string,
    startedAt: number,
  ): Promise<void> {
    await this.options.store.recordUsage({
      requestId: request.requestId,
      channelId,
      modelAlias: request.model,
      upstreamModel,
      clientName: request.clientName,
      requestKind: request.kind,
      statusCode,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      errorType,
      retryCount,
      streamed: request.stream,
      endpoint: request.endpoint ?? null,
      sourceIp: request.sourceIp ?? null,
    });
  }
}
