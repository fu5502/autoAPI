import type { Channel, GatewayRequest, ProbeResult, Protocol } from "../../domain/types.js";
import type { AdapterAttempt, UpstreamAdapter } from "../adapter.js";
import { UpstreamError } from "../errors.js";
import { fetchUpstream, jsonHeaders, parseJson, responseHeaders } from "../http.js";
import { errorMessage, optionalBalance, probeJson, probeStream } from "../probe-utils.js";
import { apiUrl } from "../url.js";

export class OpenAiAdapter implements UpstreamAdapter {
  readonly protocol = "openai" as const;

  supports(request: GatewayRequest): boolean {
    return request.kind === "chat" || request.kind === "responses";
  }

  async listModels(channel: Channel, apiKey: string, timeoutMs: number): Promise<string[]> {
    const body = await probeJson(apiUrl(channel.baseUrl, "/v1/models"), { headers: jsonHeaders(apiKey) }, timeoutMs);
    const models = parseModels(body);
    if (models.length === 0) throw new Error("Upstream did not expose any models");
    return models;
  }

  async execute(
    channel: Channel,
    apiKey: string,
    request: GatewayRequest,
    upstreamModel: string,
    timeoutMs: number,
  ): Promise<AdapterAttempt> {
    if (request.kind !== "responses") {
      return executeOpenAiPath(channel, apiKey, request, upstreamModel, timeoutMs, "/v1/chat/completions", request.body);
    }

    try {
      return await executeOpenAiPath(channel, apiKey, request, upstreamModel, timeoutMs, "/v1/responses", request.body);
    } catch (error) {
      if (!(error instanceof UpstreamError) || (error.statusCode !== 404 && error.statusCode !== 405)) throw error;
      return executeResponsesViaChat(channel, apiKey, request, upstreamModel, timeoutMs);
    }
  }

  async probe(channel: Channel, apiKey: string, timeoutMs: number): Promise<ProbeResult> {
    const startedAt = Date.now();
    const headers = jsonHeaders(apiKey);
    try {
      let models = channel.models;
      try {
        models = await this.listModels(channel, apiKey, timeoutMs);
      } catch (error) {
        if (models.length === 0) throw error;
      }
      const model = models[0];
      if (!model) throw new Error("Upstream did not expose any models");
      const balancePromise = optionalBalance(channel, apiKey, timeoutMs);
      const chat = await probeOpenAiGeneration(channel, apiKey, model, false, timeoutMs);
      const stream = await probeOpenAiGeneration(channel, apiKey, model, true, timeoutMs);
      const balance = await balancePromise;
      return {
        ok: true,
        protocol: detectFlavor(channel),
        models,
        latencyMs: Date.now() - startedAt,
        chatOk: chat,
        streamOk: stream,
        balance: balance.balance,
        balanceCurrency: balance.currency,
        balanceStatus: balance.status,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        protocol: detectFlavor(channel),
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

async function executeOpenAiPath(
  channel: Channel,
  apiKey: string,
  request: GatewayRequest,
  upstreamModel: string,
  timeoutMs: number,
  path: "/v1/chat/completions" | "/v1/responses",
  body: Record<string, unknown>,
): Promise<AdapterAttempt> {
  const payload = { ...body, model: upstreamModel, stream: request.stream };
  const { response, body: responseBody } = await fetchUpstream(
    apiUrl(channel.baseUrl, path),
    { method: "POST", headers: jsonHeaders(apiKey, request.protocolHeaders), body: JSON.stringify(payload) },
    timeoutMs,
    request.stream,
  );
  const usage = responseBody instanceof Uint8Array ? readUsage(responseBody) : { promptTokens: 0, completionTokens: 0 };
  return {
    result: {
      channelId: channel.id,
      status: response.status,
      headers: responseHeaders(response, request.stream),
      body: responseBody,
      streaming: request.stream,
    },
    ...usage,
  };
}

async function executeResponsesViaChat(
  channel: Channel,
  apiKey: string,
  request: GatewayRequest,
  upstreamModel: string,
  timeoutMs: number,
): Promise<AdapterAttempt> {
  const chatBody = responsesToChatBody(request.body);
  const chatRequest: GatewayRequest = { ...request, kind: "chat", body: chatBody };
  const attempt = await executeOpenAiPath(channel, apiKey, chatRequest, upstreamModel, timeoutMs, "/v1/chat/completions", chatBody);
  if (attempt.result.body instanceof Uint8Array) {
    const body = new TextEncoder().encode(JSON.stringify(chatToResponses(parseJson(attempt.result.body), upstreamModel)));
    return {
      ...attempt,
      result: { ...attempt.result, headers: { ...attempt.result.headers, "content-type": "application/json" }, body, streaming: false },
    };
  }
  return {
    ...attempt,
    result: { ...attempt.result, body: chatStreamToResponses(attempt.result.body, upstreamModel), streaming: true },
  };
}

function responsesToChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  if (typeof body.input === "string") messages.push({ role: "user", content: body.input });
  else if (Array.isArray(body.input)) messages.push(...body.input.flatMap(toChatMessages));
  if (messages.length === 0 && Array.isArray(body.messages)) messages.push(...body.messages.filter(isRecord));

  const output: Record<string, unknown> = { messages };
  for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "tools", "tool_choice", "parallel_tool_calls", "frequency_penalty", "presence_penalty"]) {
    if (key in body) output[key] = body[key];
  }
  return output;
}

function toChatMessages(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const role = value.role === "assistant" || value.role === "developer" || value.role === "system" ? value.role : "user";
  if (typeof value.content === "string") return [{ role, content: value.content }];
  if (!Array.isArray(value.content)) return [];
  const text = value.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.content === "string") return [part.content];
    return [];
  }).join("\n");
  return text ? [{ role, content: text }] : [];
}

function chatToResponses(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  const id = typeof payload.id === "string" ? payload.id.replace(/^chatcmpl-/, "resp_") : `resp_${Date.now()}`;
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    id,
    object: "response",
    created_at: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [{ type: "message", id: `${id}_msg`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    output_text: text,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    },
  };
}

function chatStreamToResponses(source: AsyncIterable<Uint8Array>, model: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      const responseId = `resp_${Date.now()}`;
      const messageId = `${responseId}_msg`;
      yield sseEvent(encoder, "response.created", {
        type: "response.created",
        response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
      });
      for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") continue;
          try {
            const event = JSON.parse(raw) as unknown;
            if (!isRecord(event)) continue;
            const choices = Array.isArray(event.choices) ? event.choices : [];
            const choice = isRecord(choices[0]) ? choices[0] : {};
            const delta = isRecord(choice.delta) ? choice.delta : {};
            const text = typeof delta.content === "string" ? delta.content : "";
            if (!text) continue;
            yield sseEvent(encoder, "response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: text,
            });
          } catch {
            // Ignore malformed upstream chunks; the stream remains valid for the client.
          }
        }
      }
      yield sseEvent(encoder, "response.completed", {
        type: "response.completed",
        response: { id: responseId, object: "response", model, status: "completed" },
      });
    },
  };
}

function sseEvent(encoder: TextEncoder, event: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("");
}

async function probeOpenAiGeneration(
  channel: Channel,
  apiKey: string,
  model: string,
  stream: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const headers = jsonHeaders(apiKey);
  const chatBody = { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream };
  try {
    if (stream) {
      await probeStream(
        apiUrl(channel.baseUrl, "/v1/chat/completions"),
        { method: "POST", headers, body: JSON.stringify(chatBody) },
        timeoutMs,
      );
    } else {
      await probeJson(
        apiUrl(channel.baseUrl, "/v1/chat/completions"),
        { method: "POST", headers, body: JSON.stringify(chatBody) },
        timeoutMs,
      );
    }
    return true;
  } catch {
    const responseBody = { model, input: "ping", max_output_tokens: 1, stream };
    if (stream) {
      await probeStream(
        apiUrl(channel.baseUrl, "/v1/responses"),
        { method: "POST", headers, body: JSON.stringify(responseBody) },
        timeoutMs,
      );
    } else {
      await probeJson(
        apiUrl(channel.baseUrl, "/v1/responses"),
        { method: "POST", headers, body: JSON.stringify(responseBody) },
        timeoutMs,
      );
    }
    return true;
  }
}

function parseModels(body: Record<string, unknown>): string[] {
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .flatMap((item) => (item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : []))
    .slice(0, 500);
}

function readUsage(body: Uint8Array): { promptTokens: number; completionTokens: number } {
  try {
    const payload = parseJson(body);
    const usage = payload.usage && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : {};
    return {
      promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0 };
  }
}

function detectFlavor(channel: Channel): Protocol {
  if (channel.protocol === "new-api" || channel.protocol === "sub2api") return channel.protocol;
  const value = channel.baseUrl.toLowerCase();
  if (value.includes("sub2api")) return "sub2api";
  if (value.includes("new-api") || value.includes("newapi")) return "new-api";
  return "openai";
}
