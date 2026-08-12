import { UpstreamError, toUpstreamError } from "./errors.js";
import type { AdapterUsage } from "./adapter.js";

export async function primeStream(
  response: Response,
  cleanup: () => void,
  startedAt: number,
  refreshIdleTimeout: () => void,
): Promise<{ stream: AsyncIterable<Uint8Array>; firstByteLatencyMs: number; error: Promise<UpstreamError | null> }> {
  if (!response.body) {
    cleanup();
    throw new UpstreamError("Upstream returned an empty stream", 502, true, "empty_stream");
  }
  const reader = response.body.getReader();
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await reader.read();
  } catch (error) {
    cleanup();
    throw toUpstreamError(error);
  }
  if (first.done || !first.value?.length) {
    cleanup();
    throw new UpstreamError("Upstream stream ended before the first event", 502, true, "empty_stream");
  }
  refreshIdleTimeout();
  let settleError!: (error: UpstreamError | null) => void;
  const streamError = new Promise<UpstreamError | null>((resolve) => {
    settleError = resolve;
  });
  let settled = false;
  const settle = (error: UpstreamError | null) => {
    if (settled) return;
    settled = true;
    settleError(error);
  };

  return {
    firstByteLatencyMs: Math.max(0, Date.now() - startedAt),
    error: streamError,
    stream: {
      async *[Symbol.asyncIterator]() {
        let completed = false;
        try {
          yield first.value;
          while (true) {
            const part = await reader.read();
            if (part.done) {
              completed = true;
              cleanup();
              settle(null);
              break;
            }
            refreshIdleTimeout();
            if (part.value.length) yield part.value;
          }
        } catch (error) {
          const upstreamError = toUpstreamError(error);
          settle(upstreamError);
          const payload = JSON.stringify({
            error: {
              message: upstreamError.message,
              type: "upstream_stream_interrupted",
            },
          });
          yield new TextEncoder().encode(`\nevent: error\ndata: ${payload}\n\n`);
        } finally {
          settle(null);
          cleanup();
          if (!completed) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    },
  };
}

export function mapSseStream(
  source: AsyncIterable<Uint8Array>,
  transform: (data: unknown) => unknown | null,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      let failed = false;
      for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.split(/\r?\n/).some((line) => line.trim() === "event: error")) {
            failed = true;
            yield encoder.encode(`${block}\n\n`);
            continue;
          }
          const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          if (raw === "[DONE]") continue;
          try {
            const mapped = transform(JSON.parse(raw));
            if (mapped !== null) yield encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`);
          } catch {
            // Ignore malformed intermediary events while preserving a valid downstream stream.
          }
        }
      }
      if (!failed) yield encoder.encode("data: [DONE]\n\n");
    },
  };
}

export function observeSseUsage(
  source: AsyncIterable<Uint8Array>,
  readUsage: (event: Record<string, unknown>) => Partial<AdapterUsage> | null,
): { stream: AsyncIterable<Uint8Array>; usage: Promise<AdapterUsage> } {
  let resolveUsage!: (usage: AdapterUsage) => void;
  let rejectUsage!: (error: unknown) => void;
  const usage = new Promise<AdapterUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  const collected: AdapterUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: null };

  function consumeUsage(block: string) {
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const raw = dataLine.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const next = readUsage(value as Record<string, unknown>);
      if (!next) return;
      if (typeof next.promptTokens === "number") collected.promptTokens = next.promptTokens;
      if (typeof next.completionTokens === "number") collected.completionTokens = next.completionTokens;
      if (typeof next.cachedTokens === "number") collected.cachedTokens = next.cachedTokens;
    } catch {
      // Ignore malformed intermediary events; the original bytes still reach the client.
    }
  }

  const stream: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      try {
        for await (const chunk of source) {
          buffer += decoder.decode(chunk, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) consumeUsage(block);
          yield chunk;
        }
        if (buffer.trim()) consumeUsage(buffer);
        completed = true;
        resolveUsage(collected);
      } catch (error) {
        rejectUsage(error);
        throw error;
      } finally {
        if (!completed) resolveUsage(collected);
      }
    },
  };
  return { stream, usage };
}

export function finalizeStream(
  source: AsyncIterable<Uint8Array>,
  onComplete: (consumedToEnd: boolean) => Promise<void>,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      let consumedToEnd = false;
      try {
        for await (const chunk of source) yield chunk;
        consumedToEnd = true;
      } finally {
        await onComplete(consumedToEnd);
      }
    },
  };
}
