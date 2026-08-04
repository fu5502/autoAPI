import { UpstreamError, toUpstreamError } from "./errors.js";

export async function primeStream(
  response: Response,
  cleanup: () => void,
): Promise<AsyncIterable<Uint8Array>> {
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

  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield first.value;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value.length) yield part.value;
        }
      } catch (error) {
        const payload = JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "Upstream stream interrupted",
            type: "upstream_stream_interrupted",
          },
        });
        yield new TextEncoder().encode(`\nevent: error\ndata: ${payload}\n\n`);
      } finally {
        cleanup();
        reader.releaseLock();
      }
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
      for await (const chunk of source) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
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
      yield encoder.encode("data: [DONE]\n\n");
    },
  };
}
