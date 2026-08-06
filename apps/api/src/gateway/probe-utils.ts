import type { Channel } from "../domain/types.js";
import { fetchBalance } from "./balance.js";
import { fetchUpstream, parseJson } from "./http.js";
import { isUpstreamOverloadedError } from "./errors.js";

export async function probeJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { body } = await retryOverloaded(() => fetchUpstream(url, init, timeoutMs, false));
  if (!(body instanceof Uint8Array)) throw new Error("Expected a JSON response");
  return parseJson(body);
}

export async function probeStream(url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const { body } = await retryOverloaded(() => fetchUpstream(url, init, timeoutMs, true));
  if (body instanceof Uint8Array) throw new Error("Expected a stream response");
  for await (const _chunk of body) break;
}

async function retryOverloaded<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isUpstreamOverloadedError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function optionalBalance(channel: Channel, apiKey: string, timeoutMs: number) {
  return fetchBalance(channel, apiKey, timeoutMs);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown probe error";
}
