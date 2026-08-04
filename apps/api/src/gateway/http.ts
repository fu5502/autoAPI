import { classifyUpstreamError, toUpstreamError } from "./errors.js";
import { primeStream } from "./streaming.js";

export async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  streaming: boolean,
): Promise<{ response: Response; body: Uint8Array | AsyncIterable<Uint8Array> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timeout);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    cleanup();
    throw toUpstreamError(error);
  }
  if (!response.ok) {
    const body = new Uint8Array(await response.arrayBuffer());
    cleanup();
    const message = extractErrorMessage(body) ?? `Upstream returned ${response.status}`;
    const error = classifyUpstreamError(response.status, message);
    throw Object.assign(error, { responseBody: body });
  }
  if (streaming) {
    return { response, body: await primeStream(response, cleanup) };
  }
  try {
    const body = new Uint8Array(await response.arrayBuffer());
    cleanup();
    return { response, body };
  } catch (error) {
    cleanup();
    throw toUpstreamError(error);
  }
}

export function jsonHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

export function responseHeaders(response: Response, streaming: boolean): Record<string, string> {
  return {
    "content-type": response.headers.get("content-type") ?? (streaming ? "text/event-stream" : "application/json"),
    "cache-control": streaming ? "no-cache" : "no-store",
    "x-accel-buffering": "no",
  };
}

export function parseJson(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function extractErrorMessage(body: Uint8Array): string | null {
  try {
    const value = parseJson(body);
    const error = value.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
    if (typeof value.message === "string") return value.message;
  } catch {
    const text = new TextDecoder().decode(body).trim();
    return text.slice(0, 500) || null;
  }
  return null;
}
