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

const OVERLOAD_PATTERN = /cpu\s+overloaded|system(?:\s+cpu)?\s+overloaded|server\s+overloaded|too\s+many\s+requests|负载过高|系统繁忙/i;

export function classifyUpstreamError(status: number, message: string): UpstreamError {
  const normalized = message.toLowerCase();
  const overloaded = OVERLOAD_PATTERN.test(normalized);
  const quota = /insufficient|quota|balance|credit|余额|额度/.test(normalized);
  const authentication = status === 401 || status === 403;
  const retryable = overloaded || authentication || status === 402 || status === 408 || status === 409 || status === 429 || status >= 500 || quota;
  const errorType = overloaded
    ? "upstream_overloaded"
    : authentication
      ? "upstream_auth_failed"
    : quota
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

export function isUpstreamOverloadedError(error: unknown): boolean {
  return error instanceof UpstreamError
    ? error.errorType === "upstream_overloaded"
    : OVERLOAD_PATTERN.test(error instanceof Error ? error.message : String(error));
}
