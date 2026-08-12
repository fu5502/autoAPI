import { randomUUID } from "node:crypto";
import type { Channel, GatewayRequest, ProbeResult } from "../../domain/types.js";
import type { AdapterAttempt, AdapterUsage, UpstreamAdapter } from "../adapter.js";
import { GatewayError } from "../errors.js";
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
    const path = `/v1beta/models/${encodeURIComponent(normalizeGeminiModel(upstreamModel))}:${method}`;
    const { response, body, firstByteLatencyMs, streamError } = await fetchUpstream(
      apiUrl(channel.baseUrl, path),
      { method: "POST", headers: { ...geminiHeaders(apiKey), ...(request.stream ? { accept: "text/event-stream" } : {}) }, body: JSON.stringify(toGeminiBody(request.body)) },
      timeoutMs,
      request.stream,
    );
    const contentType = response.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream") || contentType.includes("text/plain");
    if (!(body instanceof Uint8Array) && isSse) {
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
    // Non-streaming path: either not requested, or upstream returned JSON instead of SSE
    const rawBody = body instanceof Uint8Array ? body : await readAllBytes(body);
    const gemini = parseJson(rawBody);
    // Handle JSON array responses from streamGenerateContent without alt=sse
    const geminiObj = Array.isArray(gemini) ? (gemini[0] as Record<string, unknown>) ?? gemini : gemini;
    const blockReason = geminiBlockReason(geminiObj);
    if (blockReason) throw new GatewayError(`Gemini API 拒绝生成：${blockReason}`, 502, "upstream_blocked");
    const normalized = new TextEncoder().encode(JSON.stringify(toOpenAiResponse(geminiObj, request.model)));
    const usage = geminiObj.usageMetadata && typeof geminiObj.usageMetadata === "object"
      ? (geminiObj.usageMetadata as Record<string, unknown>)
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
      let model = models[0];
      if (!model) {
        models = await this.listModels(channel, apiKey, timeoutMs);
        model = models[0];
        if (!model) throw new Error("Upstream did not expose any Gemini models");
      }
      const balancePromise = optionalBalance(channel, apiKey, timeoutMs);
      const probe = await probeGeminiGeneration(channel, apiKey, model, timeoutMs);
      if (models.length > 0) {
        try {
          const discovered = await this.listModels(channel, apiKey, timeoutMs);
          if (discovered.length > 0) models = discovered;
        } catch {
          // Keep configured models when the model list is unavailable after a successful chat.
        }
      }
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
        probeReply: probe.reply,
        probeEndpoint: probe.endpoint,
        probeRequestBody: probe.requestBody,
        probeResponseRaw: probe.responseRaw,
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

interface GeminiProbeConversation {
  reply: string;
  endpoint: string;
  requestBody: string;
  responseRaw: string;
}

async function probeGeminiGeneration(
  channel: Channel,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<GeminiProbeConversation> {
  const headers = geminiHeaders(apiKey);
  const requestPayload = {
    contents: [{ role: "user", parts: [{ text: "请用一句话说明你是谁" }] }],
    generationConfig: { maxOutputTokens: 1024 },
  };
  const variants: Array<{ method: "streamGenerateContent?alt=sse" | "generateContent"; stream: boolean }> = [
    { method: "streamGenerateContent?alt=sse", stream: true },
    { method: "generateContent", stream: false },
  ];

  let lastError: unknown;
  for (const variant of variants) {
    const endpoint = apiUrl(channel.baseUrl, `/v1beta/models/${encodeURIComponent(normalizeGeminiModel(model))}:${variant.method}`);
    try {
      if (variant.stream) {
        const { body: stream } = await fetchUpstream(
          endpoint,
          {
            method: "POST",
            headers: { ...headers, accept: "text/event-stream" },
            body: JSON.stringify(requestPayload),
          },
          timeoutMs,
          true,
        );
        if (stream instanceof Uint8Array) throw new Error("Expected a stream response");
        const decoder = new TextDecoder();
        let buffer = "";
        const parts: string[] = [];
        for await (const chunk of stream) {
          buffer += decoder.decode(chunk, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const dataLine = block.split(/\r?\n/).find((line) => line.trimStart().startsWith("data:"));
            if (!dataLine) continue;
            const raw = dataLine.slice(dataLine.indexOf(":") + 1).trim();
            if (!raw) continue;
            try {
              const text = candidateText(JSON.parse(raw) as Record<string, unknown>);
              if (text) parts.push(text);
            } catch {
              // Ignore malformed intermediary events; later events may still carry text.
            }
          }
          if (parts.join("").trim()) break;
        }
        if (buffer.trim()) {
          const dataLine = buffer.split(/\r?\n/).find((line) => line.trimStart().startsWith("data:"));
          if (dataLine) {
            const raw = dataLine.slice(dataLine.indexOf(":") + 1).trim();
            if (raw) {
              try {
                const text = candidateText(JSON.parse(raw) as Record<string, unknown>);
                if (text) parts.push(text);
              } catch {
                // Ignore an incomplete final event; the stream may end without a blank line.
              }
            }
          }
        }
        const reply = parts.join("").trim();
        if (!reply) throw new Error("Upstream stream ended without text");
        return {
          reply,
          endpoint: `POST ${endpoint}`,
          requestBody: JSON.stringify(requestPayload, null, 2),
          responseRaw: parts.join(""),
        };
      }

      const body = await probeJson(
        endpoint,
        { method: "POST", headers, body: JSON.stringify(requestPayload) },
        timeoutMs,
      );
      const reply = candidateText(body);
      if (!reply) throw new Error("Upstream response did not contain text");
      return {
        reply,
        endpoint: `POST ${endpoint}`,
        requestBody: JSON.stringify(requestPayload, null, 2),
        responseRaw: JSON.stringify(body, null, 2),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseGeminiModels(response: Record<string, unknown>): string[] {
  return (Array.isArray(response.models) ? response.models : []).flatMap((item) => {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return [];
    return [item.name.replace(/^models\//, "")];
  });
}

function normalizeGeminiModel(model: string): string {
  return model.replace(/^models\//, "");
}

async function readAllBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
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

function geminiBlockReason(payload: Record<string, unknown>): string | null {
  const promptFeedback = payload.promptFeedback;
  if (promptFeedback && typeof promptFeedback === "object" && "blockReason" in promptFeedback && typeof promptFeedback.blockReason === "string") {
    return `提示被拦截（${promptFeedback.blockReason}）`;
  }
  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  if (candidate && typeof candidate === "object") {
    const finishReason = (candidate as Record<string, unknown>).finishReason;
    if (typeof finishReason === "string" && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
      if (!("content" in candidate) || !candidate.content) {
        return `生成被中断（${finishReason}）`;
      }
    }
  }
  return null;
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
  const payload = event as Record<string, unknown>;
  const text = candidateText(payload);
  const blockReason = geminiBlockReason(payload);
  const content = text || (blockReason ? `[${blockReason}]` : "");
  if (!content) return null;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
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
