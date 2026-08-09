import { randomUUID } from "node:crypto";
import type { Channel, GatewayRequest, ProbeResult } from "../../domain/types.js";
import type { AdapterAttempt, AdapterUsage, UpstreamAdapter } from "../adapter.js";
import { fetchUpstream, parseJson, responseHeaders } from "../http.js";
import { errorMessage, optionalBalance, probeJson } from "../probe-utils.js";
import { mapSseStream, observeSseUsage } from "../streaming.js";
import { apiUrl } from "../url.js";

export class GeminiAdapter implements UpstreamAdapter {
  readonly protocol = "gemini" as const;

  supports(request: GatewayRequest): boolean {
    return request.kind === "chat";
  }

  async listModels(channel: Channel, apiKey: string, timeoutMs: number): Promise<string[]> {
    const response = await probeJson(
      apiUrl(channel.baseUrl, "/v1beta/models"),
      { headers: geminiHeaders(apiKey) },
      timeoutMs,
    );
    const models = parseGeminiModels(response);
    if (models.length === 0) throw new Error("Upstream did not expose any Gemini models");
    return models;
  }

  async execute(
    channel: Channel,
    apiKey: string,
    request: GatewayRequest,
    upstreamModel: string,
    timeoutMs: number,
  ): Promise<AdapterAttempt> {
    const method = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const path = `/v1beta/models/${encodeURIComponent(upstreamModel)}:${method}`;
    const { response, body, firstByteLatencyMs, streamError } = await fetchUpstream(
      apiUrl(channel.baseUrl, path),
      { method: "POST", headers: geminiHeaders(apiKey), body: JSON.stringify(toGeminiBody(request.body)) },
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
          body: mapSseStream(observed.stream, (event) => toOpenAiChunk(event, request.model)),
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
    const gemini = parseJson(body);
    const normalized = new TextEncoder().encode(JSON.stringify(toOpenAiResponse(gemini, request.model)));
    const usage = gemini.usageMetadata && typeof gemini.usageMetadata === "object"
      ? (gemini.usageMetadata as Record<string, unknown>)
      : {};
    return {
      result: {
        channelId: channel.id,
        status: response.status,
        headers: { ...responseHeaders(response, false), "content-type": "application/json" },
        body: normalized,
        streaming: false,
      },
      promptTokens: Number(usage.promptTokenCount ?? 0),
      completionTokens: Number(usage.candidatesTokenCount ?? 0),
      cachedTokens: typeof usage.cachedContentTokenCount === "number" ? usage.cachedContentTokenCount : null,
      firstByteLatencyMs,
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
      if (!model) throw new Error("Upstream did not expose any Gemini models");
      const balancePromise = optionalBalance(channel, apiKey, timeoutMs);
      const requestPayload = { contents: [{ role: "user", parts: [{ text: "请用一句话说明你是谁" }] }], generationConfig: { maxOutputTokens: 32 } };
      const payload = JSON.stringify(requestPayload);
      const endpoint = apiUrl(channel.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
      const body = await probeJson(
        endpoint,
        { method: "POST", headers: geminiHeaders(apiKey), body: payload },
        timeoutMs,
      );
      const balance = await balancePromise;
      return {
        ok: true,
        protocol: "gemini",
        models,
        latencyMs: Date.now() - startedAt,
        chatOk: true,
        streamOk: true,
        balance: balance.balance,
        balanceCurrency: balance.currency,
        balanceStatus: balance.status,
        error: null,
        modelsChanged: models.length > 0 && JSON.stringify(models) !== JSON.stringify(channel.models),
        probedModel: model,
        probeReply: candidateText(body),
        probeEndpoint: `POST ${endpoint}`,
        probeRequestBody: JSON.stringify(requestPayload, null, 2),
        probeResponseRaw: JSON.stringify(body, null, 2),
      };
    } catch (error) {
      return {
        ok: false,
        protocol: "gemini",
        models: channel.models,
        latencyMs: Date.now() - startedAt,
        chatOk: false,
        streamOk: false,
        balance: null,
        balanceCurrency: null,
        balanceStatus: "unknown",
        error: errorMessage(error),
        modelsChanged: false,
      };
    }
  }
}

function parseGeminiModels(response: Record<string, unknown>): string[] {
  return (Array.isArray(response.models) ? response.models : []).flatMap((item) => {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return [];
    return [item.name.replace(/^models\//, "")];
  });
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey, "content-type": "application/json", accept: "application/json" };
}

function toGeminiBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<{ text: string }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const item = message as Record<string, unknown>;
    const text = contentText(item.content);
    if (!text) continue;
    if (item.role === "system") systemParts.push({ text });
    else contents.push({ role: item.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.max_tokens === "number") generationConfig.maxOutputTokens = body.max_tokens;
  return {
    contents,
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

function candidateText(payload: Record<string, unknown>): string {
  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  if (!candidate || typeof candidate !== "object" || !("content" in candidate) || !candidate.content || typeof candidate.content !== "object") return "";
  const parts: unknown[] = "parts" in candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  return parts.flatMap((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : [])).join("");
}

function toOpenAiResponse(payload: Record<string, unknown>, model: string) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: candidateText(payload) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: Number((payload.usageMetadata as Record<string, unknown> | undefined)?.promptTokenCount ?? 0),
      completion_tokens: Number((payload.usageMetadata as Record<string, unknown> | undefined)?.candidatesTokenCount ?? 0),
      total_tokens: Number((payload.usageMetadata as Record<string, unknown> | undefined)?.totalTokenCount ?? 0),
    },
  };
}

function toOpenAiChunk(event: unknown, model: string) {
  if (!event || typeof event !== "object") return null;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: candidateText(event as Record<string, unknown>) }, finish_reason: null }],
  };
}

function readStreamUsage(payload: Record<string, unknown>): Partial<AdapterUsage> | null {
  const raw = payload.usageMetadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  return {
    promptTokens: Number(usage.promptTokenCount ?? 0),
    completionTokens: Number(usage.candidatesTokenCount ?? 0),
    cachedTokens: typeof usage.cachedContentTokenCount === "number" ? usage.cachedContentTokenCount : null,
  };
}
