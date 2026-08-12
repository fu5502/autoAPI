import type { Channel, GatewayRequest, ProbeResult, Protocol } from "../../domain/types.js";
import type { AdapterAttempt, AdapterUsage, ModerationInfo, UpstreamAdapter } from "../adapter.js";
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
      if (error instanceof UpstreamError && error.statusCode === 400 && Array.isArray(request.body.input)) {
        const retry = (body: Record<string, unknown>) =>
          executeOpenAiPath(channel, apiKey, request, upstreamModel, timeoutMs, "/v1/responses", body);
        // Some relays reject structured tool history (function_call /
        // function_call_output) for certain models with a generic 400. First retry
        // flattens it to plain text; if the relay also rejects multi-message inputs
        // (e.g. opencode.ai Console Go for mimo-v2.5), a second retry collapses the
        // whole conversation into a single user message.
        const flattened = flattenResponsesInput(request.body.input);
        if (JSON.stringify(flattened) !== JSON.stringify(request.body.input)) {
          try {
            return await retry({ ...request.body, input: flattened });
          } catch (flatError) {
            if (!(flatError instanceof UpstreamError) || flatError.statusCode !== 400) throw flatError;
          }
        }
        return await retry({ ...request.body, input: collapseResponsesInput(request.body.input) });
      }
      if (!(error instanceof UpstreamError) || (error.statusCode !== 404 && error.statusCode !== 405)) throw error;
      return executeResponsesViaChat(channel, apiKey, request, upstreamModel, timeoutMs);
    }
  }

  async probe(channel: Channel, apiKey: string, timeoutMs: number): Promise<ProbeResult> {
    const startedAt = Date.now();
    const headers = jsonHeaders(apiKey);
    try {
      let models = channel.models;
      let model = models[0];
      if (!model) {
        models = await this.listModels(channel, apiKey, timeoutMs);
        model = models[0];
        if (!model) throw new Error("Upstream did not expose any models");
      }
      const balancePromise = optionalBalance(channel, apiKey, timeoutMs);
      const probe = await probeOpenAiGeneration(channel, apiKey, model, timeoutMs);
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
    ...(path === "/v1/responses" ? sanitizeResponsesBody(body) : body),
    model: upstreamModel,
    stream: request.stream,
    ...(request.stream && path === "/v1/chat/completions"
      ? { stream_options: { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true } }
      : {}),
    ...(path === "/v1/responses" && Array.isArray(body.tools)
      ? { tools: sanitizeResponsesTools(body.tools) }
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
  const upstreamStream = responseBody instanceof Uint8Array ? null : (observed?.stream ?? responseBody);
  const resultBody: Uint8Array | AsyncIterable<Uint8Array> = responseBody instanceof Uint8Array
    ? responseBody
    : path === "/v1/responses"
      ? normalizeResponsesStream(upstreamStream!)
      : observed!.stream;
  return {
    result: {
      channelId: channel.id,
      status: response.status,
      headers: responseHeaders(response, request.stream),
      body: resultBody,
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
    const parsed = parseJson(attempt.result.body) as Record<string, unknown>;
    const choice = Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) ? (parsed.choices[0] as Record<string, unknown>) : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
    const moderationInfo: ModerationInfo | null =
      finishReason === "content_filter"
        ? { errorType: "content_filter", reason: typeof message.content === "string" && message.content ? (message.content as string).slice(0, 300) : "上游内容审核拦截 (content_filter)" }
        : null;
    const body = new TextEncoder().encode(JSON.stringify(chatToResponses(parsed, upstreamModel)));
    return {
      ...attempt,
      result: { ...attempt.result, headers: { ...attempt.result.headers, "content-type": "application/json" }, body, streaming: false },
      moderation: Promise.resolve(moderationInfo),
    };
  }
  const converted = chatStreamToResponses(attempt.result.body, upstreamModel);
  return {
    ...attempt,
    result: { ...attempt.result, body: converted.stream, streaming: true },
    moderation: converted.moderation,
  };
}

/**
 * Codex sends special tool kinds besides `function` (`tool_search`, `web_search`,
 * `custom` like apply_patch). Many relay backends reject those for non-official
 * models with a generic 400 "Provider returned error", so we forward only
 * standard function tools. `strict: true` is also dropped because some relays
 * reject strict schemas for certain models.
 */
function sanitizeResponsesTools(tools: unknown[]): unknown[] {
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function") return [];
    if (!("strict" in tool)) return [tool];
    const { strict: _strict, ...rest } = tool;
    return [rest];
  });
}

/** Codex-only session/metadata fields that strict relays reject. */
const CODEX_ONLY_FIELDS = new Set([
  "prompt_cache_key",
  "client_metadata",
  "turn_id",
  "session_id",
  "thread_id",
  "x-codex-installation-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
]);

function sanitizeResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (CODEX_ONLY_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Replaces every `function_call` / `function_call_output` item or content part
 * in a Responses input with plain-text descriptions. Some relays reject the
 * structured tool history for non-official models with a generic 400, while the
 * same conversation flattened to text succeeds. Text-only turns are kept as-is.
 */
function flattenResponsesInput(input: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      out.push(item);
      continue;
    }
    if (item.type === "function_call") {
      pushTextMessage(out, "assistant", describeToolCall(item));
      continue;
    }
    if (item.type === "function_call_output") {
      pushTextMessage(out, "user", describeToolOutput(item));
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      const content = item.content.map((part) => {
        if (!isRecord(part)) return part;
        if (part.type === "function_call") return { type: "output_text", text: describeToolCall(part) };
        if (part.type === "function_call_output") return { type: "output_text", text: describeToolOutput(part) };
        return part;
      });
      out.push({ ...item, content });
      continue;
    }
    out.push(item);
  }
  return out;
}

function pushTextMessage(messages: unknown[], role: "user" | "assistant", text: string): void {
  const last = messages[messages.length - 1];
  if (isRecord(last) && last.type === "message" && last.role === role && Array.isArray(last.content)) {
    last.content = [...last.content, { type: "output_text", text }];
    return;
  }
  messages.push({ type: "message", id: `msg_${randomSuffix()}`, role, content: [{ type: "output_text", text }] });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function describeToolCall(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  const args = typeof item.arguments === "string" && item.arguments ? item.arguments : "{}";
  return `[tool_call ${name}] ${args}`;
}

function describeToolOutput(item: Record<string, unknown>): string {
  const output = item.output;
  const text = output === undefined || output === null
    ? ""
    : typeof output === "string"
      ? output
      : JSON.stringify(output);
  return text ? `[tool_result] ${text}` : "[tool_result]";
}

/**
 * Collapses the whole Responses input into a single user message. Some relays
 * reject multi-message inputs entirely for certain models (e.g. opencode.ai
 * Console Go rejects every multi-turn request for mimo-v2.5 with a generic 400),
 * even when the history contains no tool calls. A single concatenated message
 * keeps the conversation context while satisfying that constraint.
 */
function collapseResponsesInput(input: unknown[]): unknown[] {
  const lines: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call") {
      lines.push(describeToolCall(item));
      continue;
    }
    if (item.type === "function_call_output") {
      lines.push(describeToolOutput(item));
      continue;
    }
    if (item.type !== "message") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const texts: string[] = [];
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "input_text" || part.type === "output_text") {
        if (typeof part.text === "string" && part.text.trim()) texts.push(part.text);
      } else if (part.type === "function_call") {
        texts.push(describeToolCall(part));
      } else if (part.type === "function_call_output") {
        texts.push(describeToolOutput(part));
      }
    }
    if (texts.length > 0) lines.push(`${role}: ${texts.join("\n")}`);
  }
  const text = lines.length > 0 ? lines.join("\n") : "";
  return [{ type: "message", id: `msg_${randomSuffix()}`, role: "user", content: [{ type: "input_text", text }] }];
}

/**
 * Some relays emit non-compliant Responses SSE: they send `output_text.delta` /
 * `function_call_arguments.delta` without the standard `response.created` /
 * `in_progress` prelude and without the `*_done` / `output_item.done` closing
 * events (e.g. opencode.ai Console Go for mimo-v2.5). Codex depends on that
 * sequence to render output and finish tool calls, so we synthesize the missing
 * events and patch deltas that lack `item_id` / `output_index`. Compliant
 * streams already carrying those events pass through unchanged.
 */
type NormalizedItemKind = "message" | "reasoning" | "function_call";

interface NormalizedItem {
  kind: NormalizedItemKind;
  outputIndex: number;
  text: string;
  done: boolean;
  callId?: string;
  name?: string;
}

function normalizeResponsesStream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const normalized: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      let responseId = "";
      let responseModel = "";
      let started = false;
      let inProgress = false;
      const items = new Map<string, NormalizedItem>();

      const ensureHeader = (eventId: string): Uint8Array[] => {
        const out: Uint8Array[] = [];
        if (!started) {
          started = true;
          out.push(sseEvent(encoder, "response.created", {
            type: "response.created",
            id: eventId,
            response: { id: eventId, status: "in_progress", ...(responseModel ? { model: responseModel } : {}) },
          }));
        }
        if (!inProgress) {
          inProgress = true;
          out.push(sseEvent(encoder, "response.in_progress", {
            type: "response.in_progress",
            id: eventId,
            response: { id: eventId, status: "in_progress", ...(responseModel ? { model: responseModel } : {}) },
          }));
        }
        return out;
      };

      const synthesizeItemPrelude = (itemId: string, item: NormalizedItem): Uint8Array[] => {
        const out = ensureHeader(responseId || itemId);
        if (item.kind === "function_call") {
          out.push(sseEvent(encoder, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: item.outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: item.callId ?? itemId,
              name: item.name ?? "",
              arguments: "",
              status: "in_progress",
            },
          }));
        } else if (item.kind === "reasoning") {
          out.push(sseEvent(encoder, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: item.outputIndex,
            item: { type: "reasoning", id: itemId, summary: [] },
          }));
          out.push(sseEvent(encoder, "response.content_part.added", {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: item.outputIndex,
            content_index: 0,
            part: { type: "summary_text", text: "" },
          }));
        } else {
          out.push(sseEvent(encoder, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: item.outputIndex,
            item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
          }));
          out.push(sseEvent(encoder, "response.content_part.added", {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: item.outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
        }
        return out;
      };

      const finalizeItem = (itemId: string, item: NormalizedItem): Uint8Array[] => {
        const out: Uint8Array[] = [];
        if (item.kind === "function_call") {
          out.push(sseEvent(encoder, "response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: item.outputIndex,
            arguments: item.text,
          }));
          out.push(sseEvent(encoder, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: item.outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              call_id: item.callId ?? itemId,
              name: item.name ?? "",
              arguments: item.text,
              status: "completed",
            },
          }));
        } else if (item.kind === "reasoning") {
          out.push(sseEvent(encoder, "response.reasoning_text.done", {
            type: "response.reasoning_text.done",
            item_id: itemId,
            output_index: item.outputIndex,
            text: item.text,
          }));
          out.push(sseEvent(encoder, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: item.outputIndex,
            item: { type: "reasoning", id: itemId, summary: [{ type: "summary_text", text: item.text }] },
          }));
        } else {
          out.push(sseEvent(encoder, "response.output_text.done", {
            type: "response.output_text.done",
            item_id: itemId,
            output_index: item.outputIndex,
            content_index: 0,
            text: item.text,
          }));
          out.push(sseEvent(encoder, "response.content_part.done", {
            type: "response.content_part.done",
            item_id: itemId,
            output_index: item.outputIndex,
            content_index: 0,
            part: { type: "output_text", text: item.text, annotations: [] },
          }));
          out.push(sseEvent(encoder, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: item.outputIndex,
            item: {
              type: "message",
              id: itemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: item.text, annotations: [] }],
            },
          }));
        }
        return out;
      };

      for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.trim()) continue;
          const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
          if (!dataLine) {
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          const raw = dataLine.slice(5).trim();
          if (!raw || raw === "[DONE]") {
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          const type = typeof event.type === "string" ? event.type : "";
          const id = typeof event.id === "string" ? event.id : "";
          if (!responseId && id) responseId = id;
          const resp = isRecord(event.response) ? event.response : {};
          if (!responseModel && typeof resp.model === "string") responseModel = resp.model;

          if (type === "response.created" || type === "response.in_progress") {
            if (type === "response.created") started = true;
            if (type === "response.in_progress") inProgress = true;
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          // Guarantee the prelude precedes any other event, even when the
          // upstream stream starts directly with an output_item/delta.
          if (!started) {
            for (const piece of ensureHeader(responseId || id)) yield piece;
          }
          if (type === "response.output_item.added") {
            const item = isRecord(event.item) ? event.item : {};
            if (typeof item.id === "string") {
              const base: NormalizedItem = {
                kind: item.type === "function_call" ? "function_call" : item.type === "reasoning" ? "reasoning" : "message",
                outputIndex: typeof event.output_index === "number" ? event.output_index : 0,
                text: "",
                done: false,
              };
              if (item.type === "function_call") {
                if (typeof item.call_id === "string") base.callId = item.call_id;
                if (typeof item.name === "string") base.name = item.name;
              }
              items.set(item.id, base);
            }
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          if (type === "response.output_text.delta" || type === "response.reasoning_text.delta") {
            const text = typeof event.delta === "string" ? event.delta : "";
            const itemId = typeof event.item_id === "string" ? event.item_id : `msg_${responseId || id}`;
            const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
            let item = items.get(itemId);
            if (!item) {
              item = {
                kind: type === "response.reasoning_text.delta" ? "reasoning" : "message",
                outputIndex,
                text: "",
                done: false,
              };
              items.set(itemId, item);
              for (const piece of synthesizeItemPrelude(itemId, item)) yield piece;
            }
            item.text += text;
            if (typeof event.item_id === "string" && typeof event.output_index === "number") {
              yield encoder.encode(`${block}\n\n`);
            } else {
              yield encoder.encode(`data: ${JSON.stringify({ ...event, item_id: itemId, output_index: outputIndex, content_index: 0 })}\n\n`);
            }
            continue;
          }
          if (type === "response.function_call_arguments.delta") {
            const text = typeof event.delta === "string" ? event.delta : "";
            const itemId = typeof event.item_id === "string" ? event.item_id : `call_${responseId || id}`;
            const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
            let item = items.get(itemId);
            if (!item) {
              item = {
                kind: "function_call",
                outputIndex,
                text: "",
                done: false,
                ...(typeof event.function_call_id === "string"
                  ? { callId: event.function_call_id as string }
                  : {}),
              };
              items.set(itemId, item);
              for (const piece of synthesizeItemPrelude(itemId, item)) yield piece;
            }
            item.text += text;
            if (typeof event.item_id === "string" && typeof event.output_index === "number") {
              yield encoder.encode(`${block}\n\n`);
            } else {
              yield encoder.encode(`data: ${JSON.stringify({ ...event, item_id: itemId, output_index: outputIndex })}\n\n`);
            }
            continue;
          }
          if (type === "response.function_call_arguments.done") {
            const itemId = typeof event.item_id === "string" ? event.item_id : "";
            const item = itemId ? items.get(itemId) : undefined;
            if (item) {
              item.done = true;
              if (typeof event.arguments === "string" && event.arguments) item.text = event.arguments;
            }
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          if (type === "response.output_item.done") {
            const item = isRecord(event.item) ? event.item : {};
            const itemId = typeof item.id === "string" ? item.id : "";
            const tracked = itemId ? items.get(itemId) : undefined;
            if (tracked) tracked.done = true;
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          if (type === "response.completed") {
            const prelude: Uint8Array[] = [];
            for (const [itemId, item] of items) {
              if (item.done) continue;
              item.done = true;
              prelude.push(...finalizeItem(itemId, item));
            }
            for (const piece of prelude) yield piece;
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          yield encoder.encode(`${block}\n\n`);
        }
      }
      if (buffer.trim()) yield encoder.encode(`${buffer}\n\n`);
    },
  };
  return trackResponsesEvents(normalized);
}

/**
 * 诊断观测器：记录每次 Responses 流实际发送给客户端的事件序列。
 * 当客户端提前断开（499）时输出最后发送的事件，用于定位"断在哪个
 * 事件后"。仅匹配 `response.*` 顶层事件（排除 item 内嵌的 type），
 * 并依据是否出现 `response.completed` / `response.failed` 判定完整结束，
 * 避免消费方提前 return() generator 造成的误报。仅排查用，写 stderr。
 */
function trackResponsesEvents(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const events: string[] = [];
      let sawTerminal = false;
      try {
        for await (const chunk of stream) {
          const text = new TextDecoder().decode(chunk);
          const matches = [...text.matchAll(/"type":"(response\.[^"]+)"/g)];
          for (const match of matches) {
            events.push(match[1]!);
            if (events.length > 80) events.shift();
            if (match[1] === "response.completed" || match[1] === "response.failed") sawTerminal = true;
          }
          yield chunk;
        }
        console.error(`[responses-stream-diag] finished=yes terminal=${sawTerminal} events=${JSON.stringify(events.slice(-40))}`);
      } catch (error) {
        console.error(`[responses-stream-diag] finished=aborted error=${error instanceof Error ? error.message : String(error)} events=${JSON.stringify(events.slice(-40))}`);
        throw error;
      } finally {
        if (!sawTerminal) {
          console.error(`[responses-stream-diag] finished=client_closed events=${JSON.stringify(events.slice(-40))}`);
        }
      }
    },
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
  const role = value.role === "assistant" ? "assistant" : value.role === "developer" || value.role === "system" ? "system" : "user";
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

function chatStreamToResponses(source: AsyncIterable<Uint8Array>, model: string): { stream: AsyncIterable<Uint8Array>; moderation: Promise<ModerationInfo | null> } {
  let moderationInfo: ModerationInfo | null = null;
  let resolveModeration!: (info: ModerationInfo | null) => void;
  let moderationResolved = false;
  const moderation = new Promise<ModerationInfo | null>((resolve) => {
    resolveModeration = resolve;
  });
  const finishModeration = () => {
    if (!moderationResolved) {
      moderationResolved = true;
      resolveModeration(moderationInfo);
    }
  };
  const stream: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      const createdAt = Math.floor(Date.now() / 1000);
      const responseId = `resp_${Date.now()}`;
      const messageId = `${responseId}_msg`;
      const toolCalls = new Map<number, { index: number; itemId: string; callId: string; name: string; arguments: string }>();
      let outputText = "";
      let failed = false;
      let messageAnnounced = false;
      let reasoningText = "";
      let reasoningAnnounced = false;
      const reasoningId = `rs_${responseId}`;
      let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
      const msgIndex = () => reasoningAnnounced ? 1 : 0;
      const tcIndex = (idx: number) => (reasoningAnnounced ? 1 : 0) + (outputText ? idx + 1 : idx);
      const baseResponse = { id: responseId, object: "response" as const, created_at: createdAt, model };
      try {
        yield sseEvent(encoder, "response.created", {
          type: "response.created",
          response: { ...baseResponse, status: "in_progress", output: [] },
        });
        yield sseEvent(encoder, "response.in_progress", {
          type: "response.in_progress",
          response: { ...baseResponse, status: "in_progress", output: [] },
        });
        for await (const chunk of source) {
          buffer += decoder.decode(chunk, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const eventName = block.split(/\r?\n/).find((item) => item.startsWith("event:"))?.slice(6).trim();
            const line = block.split("\n").find((item) => item.startsWith("data:"));
            if (!line) {
              // 透传 keep-alive 注释（如 ": keep-alive"），防止客户端 idle timeout
              yield encoder.encode(": keep-alive\n\n");
              continue;
            }
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") continue;
            try {
              const event = JSON.parse(raw) as unknown;
              if (!isRecord(event)) continue;
              if (eventName === "error" || isRecord(event.error)) {
                failed = true;
                const errObj = isRecord(event.error) ? event.error : event;
                if (!moderationInfo) {
                  const rawReason = typeof errObj.message === "string" && errObj.message
                    ? errObj.message
                    : JSON.stringify(errObj);
                  moderationInfo = { errorType: "upstream_error", reason: rawReason.slice(0, 300) };
                }
                yield sseEvent(encoder, "response.failed", {
                  type: "response.failed",
                  response: { id: responseId, object: "response", model, status: "failed", error: errObj },
                });
                continue;
              }
              if (isRecord(event.usage)) {
                const u = event.usage as Record<string, unknown>;
                usage = {
                  input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
                  output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
                  total_tokens: Number(u.total_tokens ?? 0),
                };
              }
              const choices = Array.isArray(event.choices) ? event.choices : [];
              const choice = isRecord(choices[0]) ? choices[0] : {};
              const delta = isRecord(choice.delta) ? choice.delta : {};
              const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
              if (reasoning) {
                if (!reasoningAnnounced) {
                  reasoningAnnounced = true;
                  yield sseEvent(encoder, "response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "reasoning", id: reasoningId, summary: [] },
                  });
                  yield sseEvent(encoder, "response.reasoning_summary_part.added", {
                    type: "response.reasoning_summary_part.added",
                    item_id: reasoningId,
                    output_index: 0,
                    summary_index: 0,
                    part: { type: "summary_text", text: "" },
                  });
                }
                reasoningText += reasoning;
                yield sseEvent(encoder, "response.reasoning_summary_text.delta", {
                  type: "response.reasoning_summary_text.delta",
                  item_id: reasoningId,
                  output_index: 0,
                  summary_index: 0,
                  delta: reasoning,
                });
              }
              const text = typeof delta.content === "string" ? delta.content : "";
              // 上游以 HTTP 200 形式返回的审核拦截：content_filter。此时 usage 为 0，需标记为真实错误原因。
              const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
              if (finishReason === "content_filter" && !moderationInfo) {
                const reason = outputText ? outputText.slice(0, 300) : "上游内容审核拦截 (content_filter)";
                moderationInfo = { errorType: "content_filter", reason };
              }
              if (text) {
                if (!messageAnnounced) {
                  messageAnnounced = true;
                  yield sseEvent(encoder, "response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: msgIndex(),
                    item: { type: "message", id: messageId, status: "in_progress", role: "assistant", content: [] },
                  });
                  yield sseEvent(encoder, "response.content_part.added", {
                    type: "response.content_part.added",
                    item_id: messageId,
                    output_index: msgIndex(),
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                  });
                }
                outputText += text;
                yield sseEvent(encoder, "response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: messageId,
                  output_index: msgIndex(),
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
                    output_index: tcIndex(index),
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
                    output_index: tcIndex(index),
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
        if (reasoningAnnounced) {
          yield sseEvent(encoder, "response.reasoning_summary_text.done", {
            type: "response.reasoning_summary_text.done",
            item_id: reasoningId,
            output_index: 0,
            summary_index: 0,
            text: reasoningText,
          });
          yield sseEvent(encoder, "response.reasoning_summary_part.done", {
            type: "response.reasoning_summary_part.done",
            item_id: reasoningId,
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: reasoningText },
          });
          yield sseEvent(encoder, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "reasoning", id: reasoningId, summary: [{ type: "summary_text", text: reasoningText }] },
          });
        }
        if (messageAnnounced) {
          yield sseEvent(encoder, "response.output_text.done", {
            type: "response.output_text.done",
            item_id: messageId,
            output_index: msgIndex(),
            content_index: 0,
            text: outputText,
          });
          yield sseEvent(encoder, "response.content_part.done", {
            type: "response.content_part.done",
            item_id: messageId,
            output_index: msgIndex(),
            content_index: 0,
            part: { type: "output_text", text: outputText, annotations: [] },
          });
          yield sseEvent(encoder, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: msgIndex(),
            item: { type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: outputText, annotations: [] }] },
          });
        }
        for (const state of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
          const outputIndex = tcIndex(state.index);
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
        if (reasoningAnnounced) output.push({ type: "reasoning", id: reasoningId, summary: [{ type: "summary_text", text: reasoningText }] });
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
          response: { ...baseResponse, status: "completed", output, output_text: outputText, ...(usage ? { usage } : {}) },
        });
      } finally {
        finishModeration();
      }
    },
  };
  return { stream, moderation };
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

async function probeOpenAiStream(
  channel: Channel,
  apiKey: string,
  model: string,
  timeoutMs: number,
  body: Record<string, unknown>,
): Promise<ProbeConversation> {
  const endpoint = apiUrl(channel.baseUrl, "/v1/chat/completions");
  const { body: stream } = await fetchUpstream(
    endpoint,
    {
      method: "POST",
      headers: { ...jsonHeaders(apiKey), accept: "text/event-stream" },
      body: JSON.stringify(body),
    },
    timeoutMs,
    true,
  );
  if (stream instanceof Uint8Array) throw new Error("Expected a stream response");

  const decoder = new TextDecoder();
  let buffer = "";
  const content: string[] = [];
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLine = block.split(/\r?\n/).find((line) => line.trimStart().startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(dataLine.indexOf(":") + 1).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : {};
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const text = typeof delta.content === "string" ? delta.content : contentText(delta.content);
        if (text) content.push(text);
      } catch {
        // Ignore malformed intermediary events; later events may still carry text.
      }
    }
    if (content.join("").trim()) break;
  }
  if (buffer.trim()) {
    const dataLine = buffer.split(/\r?\n/).find((line) => line.trimStart().startsWith("data:"));
    if (dataLine) {
      const raw = dataLine.slice(dataLine.indexOf(":") + 1).trim();
      if (raw && raw !== "[DONE]") {
        try {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : {};
          const delta = isRecord(choice.delta) ? choice.delta : {};
          const text = typeof delta.content === "string" ? delta.content : contentText(delta.content);
          if (text) content.push(text);
        } catch {
          // Ignore an incomplete final event; the stream may end without a blank line.
        }
      }
    }
  }

  const reply = content.join("").trim();
  if (!reply) throw new Error("Upstream stream ended without text");
  return {
    reply,
    endpoint: `POST ${endpoint}`,
    requestBody: JSON.stringify(body, null, 2),
    responseRaw: content.join(""),
  };
}

async function probeOpenAiGeneration(
  channel: Channel,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProbeConversation> {
  const headers = jsonHeaders(apiKey);
  const variants: Array<{
    path: string;
    body: Record<string, unknown>;
    extract?: (body: Record<string, unknown>) => string;
    stream?: boolean;
  }> = [
    {
      path: "/v1/chat/completions",
      body: { model, messages: [{ role: "user", content: "请用一句话说明你是谁" }], max_tokens: 1024, stream: true, stream_options: { include_usage: true } },
      stream: true,
    },
    {
      path: "/v1/chat/completions",
      body: { model, messages: [{ role: "user", content: "请用一句话说明你是谁" }], stream: true, stream_options: { include_usage: true } },
      stream: true,
    },
    {
      path: "/v1/chat/completions",
      body: { model, messages: [{ role: "user", content: "请用一句话说明你是谁" }], max_tokens: 1024, stream: false },
      extract: extractChatReply,
    },
    {
      path: "/v1/chat/completions",
      body: { model, messages: [{ role: "user", content: "请用一句话说明你是谁" }], stream: false },
      extract: extractChatReply,
    },
    {
      path: "/v1/responses",
      body: { model, input: "请用一句话说明你是谁", max_output_tokens: 1024, stream: false },
      extract: extractResponsesReply,
    },
  ];

  let lastError: unknown;
  for (const variant of variants) {
    const endpoint = apiUrl(channel.baseUrl, variant.path);
    try {
      if (variant.stream) {
        return await probeOpenAiStream(channel, apiKey, model, timeoutMs, variant.body);
      }
      const body = await probeJson(
        endpoint,
        { method: "POST", headers, body: JSON.stringify(variant.body) },
        timeoutMs,
      );
      return {
        reply: variant.extract?.(body) ?? "",
        endpoint: `POST ${endpoint}`,
        requestBody: JSON.stringify(variant.body, null, 2),
        responseRaw: JSON.stringify(body, null, 2),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
  // GLM/codebuddy2openai 用 prompt_cache_hit_tokens 表示缓存命中
  const hitTokens = usage.prompt_cache_hit_tokens;
  if (typeof hitTokens === "number" && hitTokens > 0) return hitTokens;
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
