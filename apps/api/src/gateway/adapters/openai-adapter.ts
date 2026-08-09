import type { Channel, GatewayRequest, ProbeResult, Protocol } from "../../domain/types.js";
import type { AdapterAttempt, AdapterUsage, UpstreamAdapter } from "../adapter.js";
import { UpstreamError } from "../errors.js";
import { fetchUpstream, jsonHeaders, parseJson, responseHeaders } from "../http.js";
import { observeSseUsage } from "../streaming.js";
import { errorMessage, optionalBalance, probeJson } from "../probe-utils.js";
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
      const probe = await probeOpenAiGeneration(channel, apiKey, model, timeoutMs);
      const balance = await balancePromise;
      return {
        ok: true,
        protocol: detectFlavor(channel),
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
        protocol: detectFlavor(channel),
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

async function executeOpenAiPath(
  channel: Channel,
  apiKey: string,
  request: GatewayRequest,
  upstreamModel: string,
  timeoutMs: number,
  path: "/v1/chat/completions" | "/v1/responses",
  body: Record<string, unknown>,
): Promise<AdapterAttempt> {
  const payload = {
    ...body,
    model: upstreamModel,
    stream: request.stream,
    ...(request.stream && path === "/v1/chat/completions"
      ? { stream_options: { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true } }
      : {}),
  };
  const { response, body: responseBody, firstByteLatencyMs, streamError } = await fetchUpstream(
    apiUrl(channel.baseUrl, path),
    { method: "POST", headers: jsonHeaders(apiKey, request.protocolHeaders), body: JSON.stringify(payload) },
    timeoutMs,
    request.stream,
  );
  const usage = responseBody instanceof Uint8Array ? readUsage(responseBody) : { promptTokens: 0, completionTokens: 0, cachedTokens: null };
  const observed = responseBody instanceof Uint8Array ? null : observeSseUsage(responseBody, readStreamUsage);
  return {
    result: {
      channelId: channel.id,
      status: response.status,
      headers: responseHeaders(response, request.stream),
      body: observed?.stream ?? responseBody,
      streaming: request.stream,
    },
    ...usage,
    firstByteLatencyMs,
    ...(observed ? { streamUsage: observed.usage } : {}),
    ...(streamError ? { streamError } : {}),
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
  for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "parallel_tool_calls", "frequency_penalty", "presence_penalty"]) {
    if (key in body) output[key] = body[key];
  }
  if (typeof body.max_output_tokens === "number") output.max_completion_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) output.tools = body.tools.map(responsesToolToChatTool).filter(Boolean);
  if (body.tool_choice !== undefined) output.tool_choice = responsesToolChoiceToChat(body.tool_choice);
  return output;
}

function toChatMessages(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (value.type === "function_call_output") {
    const callId = typeof value.call_id === "string" ? value.call_id : typeof value.id === "string" ? value.id : "";
    if (!callId) return [];
    return [{ role: "tool", tool_call_id: callId, content: responseInputText(value.output) }];
  }
  if (value.type === "function_call") {
    const callId = typeof value.call_id === "string" ? value.call_id : typeof value.id === "string" ? value.id : `call_${Date.now()}`;
    const name = typeof value.name === "string" ? value.name : "";
    if (!name) return [];
    return [{
      role: "assistant",
      content: null,
      tool_calls: [{ id: callId, type: "function", function: { name, arguments: typeof value.arguments === "string" ? value.arguments : "{}" } }],
    }];
  }
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

function responsesToolToChatTool(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.type !== "function") return value;
  if (isRecord(value.function)) return value;
  if (typeof value.name !== "string" || !value.name) return null;
  return {
    type: "function",
    function: {
      name: value.name,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(isRecord(value.parameters) ? { parameters: value.parameters } : {}),
      ...(typeof value.strict === "boolean" ? { strict: value.strict } : {}),
    },
  };
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "function" || typeof value.name !== "string") return value;
  return { type: "function", function: { name: value.name } };
}

function responseInputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.content === "string") return [part.content];
    return [];
  }).join("\n");
}

function chatToResponses(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === "string" ? message.content : contentText(message.content);
  const id = typeof payload.id === "string" ? payload.id.replace(/^chatcmpl-/, "resp_") : `resp_${Date.now()}`;
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const output: Record<string, unknown>[] = [];
  if (text) {
    output.push({ type: "message", id: `${id}_msg`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  }
  for (const [index, toolCall] of chatToolCalls(message).entries()) {
    output.push(toolCallOutputItem(toolCall, index));
  }
  return {
    id,
    object: "response",
    created_at: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
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
      const toolCalls = new Map<number, { index: number; itemId: string; callId: string; name: string; arguments: string }>();
      let outputText = "";
      let failed = false;
      yield sseEvent(encoder, "response.created", {
        type: "response.created",
        response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
      });
      for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventName = block.split(/\r?\n/).find((item) => item.startsWith("event:"))?.slice(6).trim();
          const line = block.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") continue;
          try {
            const event = JSON.parse(raw) as unknown;
            if (!isRecord(event)) continue;
            if (eventName === "error" || isRecord(event.error)) {
              failed = true;
              yield sseEvent(encoder, "response.failed", {
                type: "response.failed",
                response: { id: responseId, object: "response", model, status: "failed", error: event.error ?? event },
              });
              continue;
            }
            const choices = Array.isArray(event.choices) ? event.choices : [];
            const choice = isRecord(choices[0]) ? choices[0] : {};
            const delta = isRecord(choice.delta) ? choice.delta : {};
            const text = typeof delta.content === "string" ? delta.content : "";
            if (text) {
              outputText += text;
              yield sseEvent(encoder, "response.output_text.delta", {
                type: "response.output_text.delta",
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: text,
              });
            }
            const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const rawToolCall of deltas) {
              if (!isRecord(rawToolCall)) continue;
              const index = typeof rawToolCall.index === "number" ? rawToolCall.index : toolCalls.size;
              const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {};
              let state = toolCalls.get(index);
              if (!state) {
                const callId = typeof rawToolCall.id === "string" ? rawToolCall.id : `call_${responseId}_${index}`;
                state = {
                  index,
                  itemId: `fc_${callId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
                  callId,
                  name: typeof fn.name === "string" ? fn.name : "",
                  arguments: "",
                };
                toolCalls.set(index, state);
                yield sseEvent(encoder, "response.output_item.added", {
                  type: "response.output_item.added",
                  output_index: outputText ? index + 1 : index,
                  item: { type: "function_call", id: state.itemId, call_id: state.callId, name: state.name, arguments: "", status: "in_progress" },
                });
              } else if (typeof fn.name === "string" && fn.name) {
                state.name += fn.name;
              }
              if (typeof fn.arguments === "string" && fn.arguments) {
                state.arguments += fn.arguments;
                yield sseEvent(encoder, "response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  item_id: state.itemId,
                  output_index: outputText ? index + 1 : index,
                  delta: fn.arguments,
                });
              }
            }
          } catch {
            // Ignore malformed upstream chunks; the stream remains valid for the client.
          }
        }
      }
      if (failed) return;
      for (const state of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
        const outputIndex = outputText ? state.index + 1 : state.index;
        yield sseEvent(encoder, "response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: state.itemId,
          output_index: outputIndex,
          arguments: state.arguments,
        });
        yield sseEvent(encoder, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: { type: "function_call", id: state.itemId, call_id: state.callId, name: state.name, arguments: state.arguments, status: "completed" },
        });
      }
      const output: Record<string, unknown>[] = [];
      if (outputText) output.push({ type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: outputText, annotations: [] }] });
      output.push(...[...toolCalls.values()].sort((a, b) => a.index - b.index).map((state) => ({
        type: "function_call",
        id: state.itemId,
        call_id: state.callId,
        name: state.name,
        arguments: state.arguments,
        status: "completed",
      })));
      yield sseEvent(encoder, "response.completed", {
        type: "response.completed",
        response: { id: responseId, object: "response", model, status: "completed", output, output_text: outputText },
      });
    },
  };
}

function chatToolCalls(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  if (calls.length > 0) return calls;
  if (!isRecord(message.function_call)) return [];
  return [{ id: `call_${Date.now()}`, type: "function", function: message.function_call }];
}

function toolCallOutputItem(toolCall: Record<string, unknown>, index: number): Record<string, unknown> {
  const fn = isRecord(toolCall.function) ? toolCall.function : {};
  const callId = typeof toolCall.id === "string" ? toolCall.id : `call_${Date.now()}_${index}`;
  return {
    type: "function_call",
    id: `fc_${callId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    call_id: callId,
    name: typeof fn.name === "string" ? fn.name : "",
    arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    status: "completed",
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

interface ProbeConversation {
  reply: string;
  endpoint: string;
  requestBody: string;
  responseRaw: string;
}

async function probeOpenAiGeneration(
  channel: Channel,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProbeConversation> {
  const headers = jsonHeaders(apiKey);
  const chatBody = { model, messages: [{ role: "user", content: "请用一句话说明你是谁" }], max_tokens: 32, stream: false };
  const chatEndpoint = apiUrl(channel.baseUrl, "/v1/chat/completions");
  try {
    const body = await probeJson(
      chatEndpoint,
      { method: "POST", headers, body: JSON.stringify(chatBody) },
      timeoutMs,
    );
    return {
      reply: extractChatReply(body),
      endpoint: `POST ${chatEndpoint}`,
      requestBody: JSON.stringify(chatBody, null, 2),
      responseRaw: JSON.stringify(body, null, 2),
    };
  } catch {
    const responseBody = { model, input: "请用一句话说明你是谁", max_output_tokens: 32, stream: false };
    const responsesEndpoint = apiUrl(channel.baseUrl, "/v1/responses");
    const body = await probeJson(
      responsesEndpoint,
      { method: "POST", headers, body: JSON.stringify(responseBody) },
      timeoutMs,
    );
    return {
      reply: extractResponsesReply(body),
      endpoint: `POST ${responsesEndpoint}`,
      requestBody: JSON.stringify(responseBody, null, 2),
      responseRaw: JSON.stringify(body, null, 2),
    };
  }
}

function extractChatReply(body: Record<string, unknown>): string {
  const choice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  return (typeof message.content === "string" ? message.content : contentText(message.content)).trim();
}

function extractResponsesReply(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text.trim();
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("");
    if (text.trim()) return text.trim();
  }
  return "";
}

function parseModels(body: Record<string, unknown>): string[] {
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .flatMap((item) => (item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : []))
    .slice(0, 500);
}

function readUsage(body: Uint8Array): { promptTokens: number; completionTokens: number; cachedTokens: number | null } {
  try {
    const payload = parseJson(body);
    const usage = payload.usage && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : {};
    return {
      promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
      cachedTokens: readCachedTokens(usage),
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0, cachedTokens: null };
  }
}

function readStreamUsage(payload: Record<string, unknown>): Partial<AdapterUsage> | null {
  const direct = isRecord(payload.usage) ? payload.usage : null;
  const response = isRecord(payload.response) && isRecord(payload.response.usage) ? payload.response.usage : null;
  const usage = direct ?? response;
  if (!usage) return null;
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    cachedTokens: readCachedTokens(usage),
  };
}

function readCachedTokens(usage: Record<string, unknown>): number | null {
  const direct = usage.cached_tokens;
  if (typeof direct === "number") return direct;
  for (const key of ["prompt_tokens_details", "input_tokens_details"]) {
    const details = usage[key];
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const cached = (details as Record<string, unknown>).cached_tokens;
      if (typeof cached === "number") return cached;
    }
  }
  return null;
}

function detectFlavor(channel: Channel): Protocol {
  if (channel.protocol === "new-api" || channel.protocol === "sub2api") return channel.protocol;
  const value = channel.baseUrl.toLowerCase();
  if (value.includes("sub2api")) return "sub2api";
  if (value.includes("new-api") || value.includes("newapi")) return "new-api";
  return "openai";
}
