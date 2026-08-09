import { randomUUID } from "node:crypto";
import { mapSseStream } from "../streaming.js";

export function chatToClaudeBody(body: Record<string, unknown>, upstreamModel: string, stream: boolean): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system: Array<Record<string, unknown>> = [];
  const converted: Array<Record<string, unknown>> = [];

  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = typeof raw.role === "string" ? raw.role : "";
    if (role === "system" || role === "developer") {
      const text = openAiContentText(raw.content);
      if (text) system.push({ type: "text", text });
      continue;
    }
    if (role === "tool") {
      const text = openAiContentText(raw.content);
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: typeof raw.tool_call_id === "string" ? raw.tool_call_id : "",
          content: text,
        }],
      });
      continue;
    }
    if (role === "assistant") {
      const content = toClaudeAssistantContent(raw);
      if (content.length) converted.push({ role: "assistant", content });
      continue;
    }
    const content = toClaudeUserContent(raw.content);
    if (content.length) converted.push({ role: "user", content });
  }

  const maxTokens = typeof body.max_tokens === "number"
    ? body.max_tokens
    : typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : 4096;
  const output: Record<string, unknown> = {
    model: upstreamModel,
    max_tokens: maxTokens,
    messages: converted,
    stream,
  };
  if (system.length) output.system = system;
  for (const key of ["temperature", "top_p"]) {
    if (body[key] !== undefined) output[key] = body[key];
  }
  if (body.stop !== undefined) {
    output.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (Array.isArray(body.tools)) {
    output.tools = body.tools.map(toClaudeTool).filter(Boolean);
  }
  if (body.tool_choice !== undefined) output.tool_choice = toClaudeToolChoice(body.tool_choice);
  return output;
}

export function claudeMessageToChat(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("");
  const toolCalls = content.flatMap((block) => isRecord(block) && block.type === "tool_use" ? [claudeToolCallToOpenAi(block)] : []);
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cachedTokens = typeof usage.cache_read_input_tokens === "number"
    ? usage.cache_read_input_tokens
    : typeof usage.cached_tokens === "number"
      ? usage.cached_tokens
      : null;

  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || (toolCalls.length ? null : ""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapClaudeStopReason(payload.stop_reason),
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens !== null ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    },
  };
}

export function claudeStreamToChat(source: AsyncIterable<Uint8Array>, model: string): AsyncIterable<Uint8Array> {
  let responseId = "";
  let started = false;
  let finished = false;
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  return mapSseStream(source, (event) => {
    if (!isRecord(event)) return null;
    if (!responseId) responseId = `chatcmpl-${randomUUID()}`;
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      if (typeof message.id === "string") responseId = message.id;
      started = true;
      return chatChunk(responseId, model, { role: "assistant", content: "" }, null);
    }
    if (event.type === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      const index = typeof event.index === "number" ? event.index : toolCalls.size;
      if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : `call_${responseId}_${index}`;
        const name = typeof block.name === "string" ? block.name : "";
        toolCalls.set(index, { id, name, args: "" });
        return chatChunk(responseId, model, {
          tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
        }, null);
      }
      return null;
    }
    if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      const index = typeof event.index === "number" ? event.index : 0;
      if (typeof delta.text === "string") {
        return chatChunk(responseId, model, { content: delta.text }, null);
      }
      if (typeof delta.partial_json === "string") {
        const state = toolCalls.get(index);
        if (state) {
          state.args += delta.partial_json;
          return chatChunk(responseId, model, {
            tool_calls: [{ index, id: state.id, type: "function", function: { arguments: delta.partial_json } }],
          }, null);
        }
      }
      return null;
    }
    if (event.type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (!finished && typeof delta.stop_reason === "string") {
        finished = true;
        return chatChunk(responseId, model, {}, mapClaudeStopReason(delta.stop_reason));
      }
      return null;
    }
    return null;
  });
}

function chatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toClaudeUserContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text.trim()) blocks.push({ type: "text", text: part.text });
    if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      const source = imageSourceFromUrl(part.image_url.url);
      if (source) blocks.push({ type: "image", source });
    }
  }
  return blocks;
}

function toClaudeAssistantContent(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  const blocks = toClaudeUserContent(raw.content);
  const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    blocks.push({
      type: "tool_use",
      id: typeof call.id === "string" ? call.id : `call_${Date.now()}`,
      name: typeof fn.name === "string" ? fn.name : "",
      input: parseArguments(fn.arguments),
    });
  }
  if (isRecord(raw.function_call)) {
    const fn = raw.function_call;
    blocks.push({
      type: "tool_use",
      id: `call_${Date.now()}`,
      name: typeof fn.name === "string" ? fn.name : "",
      input: parseArguments(fn.arguments),
    });
  }
  return blocks;
}

function openAiContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : [])
    .join("\n");
}

function imageSourceFromUrl(url: string): Record<string, unknown> | null {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match) return null;
  return { type: "base64", media_type: `image/${match[1]!.toLowerCase()}`, data: match[2]! };
}

function toClaudeTool(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.type !== "function") return null;
  const fn = isRecord(value.function) ? value.function : {};
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!name) return null;
  return {
    name,
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
  };
}

function toClaudeToolChoice(value: unknown): unknown {
  if (value === "none") return { type: "none" };
  if (value === "required" || value === "any") return { type: "any" };
  if (value === "auto" || value === undefined) return { type: "auto" };
  if (isRecord(value) && typeof value.type === "string") {
    return typeof value.name === "string" ? { type: value.type, name: value.name } : { type: value.type };
  }
  if (isRecord(value) && isRecord(value.function) && typeof value.function.name === "string") {
    return { type: "tool", name: value.function.name };
  }
  return { type: "auto" };
}

function claudeToolCallToOpenAi(block: Record<string, unknown>): Record<string, unknown> {
  return {
    id: typeof block.id === "string" ? block.id : `call_${Date.now()}`,
    type: "function",
    function: {
      name: typeof block.name === "string" ? block.name : "",
      arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
    },
  };
}

function mapClaudeStopReason(value: unknown): string {
  if (value === "max_tokens") return "length";
  if (value === "tool_use") return "tool_calls";
  return "stop";
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
