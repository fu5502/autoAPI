export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly errorType: string,
    readonly responseBody?: Uint8Array,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorType: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function classifyUpstreamError(status: number, message: string): UpstreamError {
  const normalized = message.toLowerCase();
  const quota = /insufficient|quota|balance|credit|余额|额度/.test(normalized);
  const retryable = status === 402 || status === 408 || status === 409 || status === 429 || status >= 500 || quota;
  const errorType = quota
    ? "balance_exhausted"
    : status === 429
      ? "rate_limited"
      : status >= 500
        ? "upstream_5xx"
        : "upstream_rejected";
  return new UpstreamError(message || `Upstream returned ${status}`, status, retryable, errorType);
}

export function toUpstreamError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new UpstreamError("Upstream request timed out", 504, true, "timeout");
  }
  const message = error instanceof Error ? error.message : "Unknown upstream error";
  return new UpstreamError(message, 502, true, "connection_error");
}
