import type { Channel, GatewayRequest, ProbeResult } from "../../domain/types.js";
import type { AdapterAttempt, UpstreamAdapter } from "../adapter.js";
import { fetchUpstream, parseJson, responseHeaders } from "../http.js";
import { errorMessage, optionalBalance, probeJson, probeStream } from "../probe-utils.js";
import { apiUrl } from "../url.js";

export class ClaudeAdapter implements UpstreamAdapter {
  readonly protocol = "claude" as const;

  supports(request: GatewayRequest): boolean {
    return request.kind === "messages";
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
    const payload = { ...request.body, model: upstreamModel, stream: request.stream };
    const { response, body } = await fetchUpstream(
      apiUrl(channel.baseUrl, "/v1/messages"),
      { method: "POST", headers: claudeHeaders(apiKey, request.protocolHeaders), body: JSON.stringify(payload) },
      timeoutMs,
      request.stream,
    );
    const usage = body instanceof Uint8Array ? readUsage(body) : { promptTokens: 0, completionTokens: 0 };
    return {
      result: {
        channelId: channel.id,
        status: response.status,
        headers: responseHeaders(response, request.stream),
        body,
        streaming: request.stream,
      },
      ...usage,
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
    return { promptTokens: Number(usage.input_tokens ?? 0), completionTokens: Number(usage.output_tokens ?? 0) };
  } catch {
    return { promptTokens: 0, completionTokens: 0 };
  }
}
