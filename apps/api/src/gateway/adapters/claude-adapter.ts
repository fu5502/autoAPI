import type { Channel, GatewayRequest, ProbeResult } from "../../domain/types.js";
import type { AdapterAttempt, AdapterUsage, UpstreamAdapter } from "../adapter.js";
import { fetchUpstream, parseJson, responseHeaders } from "../http.js";
import { errorMessage, optionalBalance, probeJson, probeStream } from "../probe-utils.js";
import { observeSseUsage } from "../streaming.js";
import { apiUrl } from "../url.js";
import { chatToClaudeBody, claudeMessageToChat, claudeStreamToChat } from "./claude-chat-bridge.js";

export class ClaudeAdapter implements UpstreamAdapter {
  readonly protocol = "claude" as const;

  supports(request: GatewayRequest): boolean {
    return request.kind === "messages" || request.kind === "chat";
  }

  async listModels(channel: Channel, apiKey: string, timeoutMs: number): Promise<string[]> {
    const body = await probeJson(apiUrl(channel.baseUrl, "/v1/models"), { headers: claudeHeaders(apiKey) }, timeoutMs);
    const models = parseModels(body);
    if (models.length === 0) throw new Error("Upstream did not expose any Claude models");
    return models;
  }

  async execute(
    channel: Channel,
    apiKey: string,
    request: GatewayRequest,
    upstreamModel: string,
    timeoutMs: number,
  ): Promise<AdapterAttempt> {
    if (request.kind === "chat") {
      return executeChatAsMessages(channel, apiKey, request, upstreamModel, timeoutMs);
    }
    const payload = { ...request.body, model: upstreamModel, stream: request.stream };
    const { response, body, firstByteLatencyMs, streamError } = await fetchUpstream(
      apiUrl(channel.baseUrl, "/v1/messages"),
      { method: "POST", headers: claudeHeaders(apiKey, request.protocolHeaders), body: JSON.stringify(payload) },
      timeoutMs,
      request.stream,
    );
    const usage = body instanceof Uint8Array ? readUsage(body) : { promptTokens: 0, completionTokens: 0, cachedTokens: null };
    const observed = body instanceof Uint8Array ? null : observeSseUsage(body, readStreamUsage);
    return {
      result: {
        channelId: channel.id,
        status: response.status,
        headers: responseHeaders(response, request.stream),
        body: observed?.stream ?? body,
        streaming: request.stream,
      },
      ...usage,
      firstByteLatencyMs,
      ...(observed ? { streamUsage: observed.usage } : {}),
      ...(streamError ? { streamError } : {}),
    };
  }

  async probe(channel: Channel, apiKey: string, timeoutMs: number): Promise<ProbeResult> {
    const startedAt = Date.now();
    try {
      let models = channel.models;
      try {
        models = await this.listModels(channel, apiKey, timeoutMs);
      } catch (error) {
        if (models.length === 0) throw error;
      }
      const model = models[0];
      if (!model) throw new Error("Upstream did not expose any Claude models");
      const balancePromise = optionalBalance(channel, apiKey, timeoutMs);
      const body = { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
      await probeJson(
        apiUrl(channel.baseUrl, "/v1/messages"),
        { method: "POST", headers: claudeHeaders(apiKey), body: JSON.stringify({ ...body, stream: false }) },
        timeoutMs,
      );
      await probeStream(
        apiUrl(channel.baseUrl, "/v1/messages"),
        { method: "POST", headers: claudeHeaders(apiKey), body: JSON.stringify({ ...body, stream: true }) },
        timeoutMs,
      );
      const balance = await balancePromise;
      return {
        ok: true,
        protocol: "claude",
        models,
        latencyMs: Date.now() - startedAt,
        chatOk: true,
        streamOk: true,
        balance: balance.balance,
        balanceCurrency: balance.currency,
        balanceStatus: balance.status,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        protocol: "claude",
        models: channel.models,
        latencyMs: Date.now() - startedAt,
        chatOk: false,
        streamOk: false,
        balance: null,
        balanceCurrency: null,
        balanceStatus: "unknown",
        error: errorMessage(error),
      };
    }
  }
}

async function executeChatAsMessages(
  channel: Channel,
  apiKey: string,
  request: GatewayRequest,
  upstreamModel: string,
  timeoutMs: number,
): Promise<AdapterAttempt> {
  const payload = chatToClaudeBody(request.body, upstreamModel, request.stream);
  const { response, body, firstByteLatencyMs, streamError } = await fetchUpstream(
    apiUrl(channel.baseUrl, "/v1/messages"),
    { method: "POST", headers: claudeHeaders(apiKey), body: JSON.stringify(payload) },
    timeoutMs,
    request.stream,
  );
  if (!(body instanceof Uint8Array)) {
    const observed = observeSseUsage(body, readStreamUsage);
    return {
      result: {
        channelId: channel.id,
        status: response.status,
        headers: { ...responseHeaders(response, true), "content-type": "text/event-stream" },
        body: claudeStreamToChat(observed.stream, request.model),
        streaming: true,
      },
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: null,
      firstByteLatencyMs,
      streamUsage: observed.usage,
      ...(streamError ? { streamError } : {}),
    };
  }
  const claude = parseJson(body);
  const normalized = new TextEncoder().encode(JSON.stringify(claudeMessageToChat(claude, request.model)));
  return {
    result: {
      channelId: channel.id,
      status: response.status,
      headers: { ...responseHeaders(response, false), "content-type": "application/json" },
      body: normalized,
      streaming: false,
    },
    ...readUsage(body),
    firstByteLatencyMs,
  };
}

function claudeHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    "x-api-key": apiKey,
    "anthropic-version": extra["anthropic-version"] ?? "2023-06-01",
    "content-type": "application/json",
    accept: "application/json",
  };
}

function parseModels(body: Record<string, unknown>): string[] {
  return (Array.isArray(body.data) ? body.data : []).flatMap((item) =>
    item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [],
  );
}

function readUsage(body: Uint8Array) {
  try {
    const payload = parseJson(body);
    const usage = payload.usage && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : {};
    return {
      promptTokens: Number(usage.input_tokens ?? 0),
      completionTokens: Number(usage.output_tokens ?? 0),
      cachedTokens: typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : typeof usage.cached_tokens === "number" ? usage.cached_tokens : null,
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0, cachedTokens: null };
  }
}

function readStreamUsage(payload: Record<string, unknown>): Partial<AdapterUsage> | null {
  const direct = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
    ? payload.usage as Record<string, unknown>
    : null;
  const message = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
    ? payload.message as Record<string, unknown>
    : null;
  const nested = message?.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
    ? message.usage as Record<string, unknown>
    : null;
  const usage = direct ?? nested;
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    ...(typeof inputTokens === "number" ? { promptTokens: inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { completionTokens: outputTokens } : {}),
    ...(typeof usage.cache_read_input_tokens === "number" ? { cachedTokens: usage.cache_read_input_tokens } : {}),
  };
}
