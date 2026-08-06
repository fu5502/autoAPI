import type { GatewayStore } from "../domain/store.js";
import type { GatewayRequest, RoutingCandidate, UpstreamResult } from "../domain/types.js";
import type { RuntimeState } from "../runtime/runtime-state.js";
import type { SecretBox } from "../security/secret-box.js";
import type { AdapterAttempt, AdapterRegistry } from "./adapter.js";
import { GatewayError, toUpstreamError } from "./errors.js";
import { eligibleCandidates, orderCandidates } from "./selector.js";
import { finalizeStream } from "./streaming.js";

export interface DirectExecution {
  result: UpstreamResult;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
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
    const [counter, routingHint] = await Promise.all([
      this.options.runtime.nextCounter(request.model),
      this.options.runtime.getRoutingHint(request.model, candidates.map((candidate) => candidate.channel.id)),
    ]);
    const attempts = orderCandidates(candidates, counter, routingHint);
    let lastError: ReturnType<typeof toUpstreamError> | null = null;
    let attemptedChannels = 0;
    for (let index = 0; index < attempts.length; index += 1) {
      const candidate = await this.getCurrentEligibleCandidate(attempts[index]!, request);
      if (!candidate) continue;
      const retryCount = attemptedChannels;
      const rememberRoute = retryCount > 0 || routingHint.preferredChannelId === candidate.channel.id;
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
        if (request.stream && !(attempt.result.body instanceof Uint8Array)) {
          return {
            ...attempt.result,
            body: finalizeStream(attempt.result.body, (consumedToEnd) => this.recordStreamResult(
              request,
              candidate.channel.id,
              candidate.upstreamModel,
              retryCount,
              attempt,
              startedAt,
              rememberRoute,
              true,
              consumedToEnd,
            )),
          };
        }
        await this.recordSuccess(request, candidate.channel.id, candidate.upstreamModel, retryCount, attempt, startedAt, rememberRoute);
        return attempt.result;
      } catch (error) {
        lastError = toUpstreamError(error);
        if (lastError.retryable) {
          await Promise.all([
            this.options.store.recordChannelFailure(
              candidate.channel.id,
              lastError.errorType,
              this.options.failureThreshold,
            ),
            this.options.runtime.recordRoutingFailure(request.model, candidate.channel.id),
          ]);
        }
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
      if (request.stream && !(attempt.result.body instanceof Uint8Array)) {
        const execution: DirectExecution = {
          result: attempt.result,
          promptTokens: attempt.promptTokens,
          completionTokens: attempt.completionTokens,
          cachedTokens: attempt.cachedTokens ?? null,
          latencyMs: Date.now() - startedAt,
          channelId: channel.id,
          upstreamModel,
        };
        execution.result = {
          ...attempt.result,
          body: finalizeStream(attempt.result.body, async (consumedToEnd) => {
            const usage = await this.readAttemptUsage(attempt);
            execution.promptTokens = usage.promptTokens;
            execution.completionTokens = usage.completionTokens;
            execution.cachedTokens = usage.cachedTokens;
            execution.latencyMs = Date.now() - startedAt;
            await this.recordStreamResult(request, channel.id, upstreamModel, 0, attempt, startedAt, false, false, consumedToEnd);
          }),
        };
        return execution;
      }
      await this.recordSuccess(request, channel.id, upstreamModel, 0, attempt, startedAt, false);
      return { ...attempt, cachedTokens: attempt.cachedTokens ?? null, latencyMs: Date.now() - startedAt, channelId: channel.id, upstreamModel };
    } catch (error) {
      const upstreamError = toUpstreamError(error);
      if (upstreamError.retryable) {
        await this.options.store.recordChannelFailure(channel.id, upstreamError.errorType, this.options.failureThreshold);
      }
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
        gatewayKeyName: request.gatewayKeyName ?? null,
        reasoningEffort: request.reasoningEffort ?? null,
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
    attempt?: AdapterAttempt,
  ): Promise<void> {
    const usage = attempt ? await this.readAttemptUsage(attempt) : { promptTokens: 0, completionTokens: 0, cachedTokens: null };
    await this.options.store.recordUsage({
      requestId: request.requestId,
      channelId,
      modelAlias: request.model,
      upstreamModel,
      clientName: request.clientName,
      requestKind: request.kind,
      statusCode,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - startedAt,
      errorType,
      retryCount,
      streamed: request.stream,
      endpoint: request.endpoint ?? null,
      sourceIp: request.sourceIp ?? null,
      gatewayKeyName: request.gatewayKeyName ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      cachedTokens: usage.cachedTokens,
      firstByteLatencyMs: attempt?.firstByteLatencyMs ?? null,
    });
  }

  private async recordStreamResult(
    request: GatewayRequest,
    channelId: string,
    upstreamModel: string,
    retryCount: number,
    attempt: AdapterAttempt,
    startedAt: number,
    rememberRoute: boolean,
    penalizeRouting: boolean,
    consumedToEnd: boolean,
  ): Promise<void> {
    const streamError = attempt.streamError ? await attempt.streamError : null;
    if (!streamError && consumedToEnd) {
      await this.recordSuccess(request, channelId, upstreamModel, retryCount, attempt, startedAt, rememberRoute);
      return;
    }
    if (!streamError) {
      await this.recordFailure(
        request,
        channelId,
        upstreamModel,
        retryCount,
        499,
        "client_closed_request",
        startedAt,
        attempt,
      );
      return;
    }
    const updates: Promise<unknown>[] = [
      this.options.store.recordChannelFailure(channelId, streamError.errorType, this.options.failureThreshold),
    ];
    if (penalizeRouting) updates.push(this.options.runtime.recordRoutingFailure(request.model, channelId));
    await Promise.all(updates);
    await this.recordFailure(
      request,
      channelId,
      upstreamModel,
      retryCount,
      streamError.statusCode,
      "upstream_stream_interrupted",
      startedAt,
      attempt,
    );
  }

  private async recordSuccess(
    request: GatewayRequest,
    channelId: string,
    upstreamModel: string,
    retryCount: number,
    attempt: AdapterAttempt,
    startedAt: number,
    rememberRoute: boolean,
  ): Promise<void> {
    const { promptTokens, completionTokens, cachedTokens } = await this.readAttemptUsage(attempt);
    const latencyMs = Date.now() - startedAt;
    await this.options.store.recordChannelSuccess(channelId, latencyMs);
    if (rememberRoute) await this.options.runtime.recordRoutingSuccess(request.model, channelId);
    await this.options.store.recordUsage({
      requestId: request.requestId,
      channelId,
      modelAlias: request.model,
      upstreamModel,
      clientName: request.clientName,
      requestKind: request.kind,
      statusCode: attempt.result.status,
      promptTokens,
      completionTokens,
      latencyMs,
      errorType: null,
      retryCount,
      streamed: request.stream,
      endpoint: request.endpoint ?? null,
      sourceIp: request.sourceIp ?? null,
      gatewayKeyName: request.gatewayKeyName ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      cachedTokens,
      firstByteLatencyMs: attempt.firstByteLatencyMs ?? null,
    });
  }

  private async readAttemptUsage(attempt: AdapterAttempt) {
    if (attempt.streamUsage) {
      try {
        return await attempt.streamUsage;
      } catch {
        // Preserve adapter defaults when the upstream stream ends abnormally.
      }
    }
    return {
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      cachedTokens: attempt.cachedTokens ?? null,
    };
  }
}
