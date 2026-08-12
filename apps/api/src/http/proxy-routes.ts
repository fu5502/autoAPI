import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayStore } from "../domain/store.js";
import type { GatewayRequest, RequestKind, UpstreamResult } from "../domain/types.js";
import { GatewayError } from "../gateway/errors.js";
import type { GatewayRouter } from "../gateway/router.js";
import { isClaudePath, requireGatewayToken } from "./auth.js";

export async function registerProxyRoutes(
  app: FastifyInstance,
  dependencies: { router: GatewayRouter; store: GatewayStore; diagnostic?: import("../logger/diagnostic-log.js").DiagnosticLogger },
) {
  const auth = requireGatewayToken(dependencies.store);
  const proxy = (kind: RequestKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const body = asBody(request.body);
    const model = typeof body.model === "string" ? body.model : "";
    if (!model) return sendProtocolError(reply, request, 400, "model is required", "invalid_request_error");
    const gatewayRequest: GatewayRequest = {
      requestId: randomUUID(),
      kind,
      model,
      stream: body.stream === true,
      body,
      clientName: clientName(request, kind),
      endpoint: endpointForKind(kind),
      sourceIp: request.ip ?? null,
      gatewayKeyName: (request as FastifyRequest & { gatewayKeyName?: string }).gatewayKeyName ?? null,
      reasoningEffort: extractReasoningEffort(body),
      protocolHeaders: protocolHeaders(request),
    };
    const result = await dependencies.router.execute(gatewayRequest);
    return sendResult(reply, result);
  };

  app.get("/v1/models", { onRequest: auth }, listModels);
  app.get("/codex/v1/models", { onRequest: auth }, listModels);
  app.get("/openai/v1/models", { onRequest: auth }, listModels);
  app.get("/anthropic/v1/models", { onRequest: auth }, listModels);
  app.get("/claude/v1/models", { onRequest: auth }, listModels);
  app.post("/v1/chat/completions", { onRequest: auth }, proxy("chat"));
  app.post("/v1/responses", { onRequest: auth }, proxy("responses"));
  app.post("/v1/messages", { onRequest: auth }, proxy("messages"));
  app.post("/anthropic/v1/messages", { onRequest: auth }, proxy("messages"));
  app.post("/claude/v1/messages", { onRequest: auth }, proxy("messages"));
  app.post("/openai/v1/chat/completions", { onRequest: auth }, proxy("chat"));
  app.post("/openai/v1/responses", { onRequest: auth }, proxy("responses"));
  app.post("/codex/v1/chat/completions", { onRequest: auth }, proxy("chat"));
  app.post("/codex/v1/responses", { onRequest: auth }, proxy("responses"));
  app.post("/codex/chat/completions", { onRequest: auth }, proxy("chat"));
  app.post("/codex/responses", { onRequest: auth }, proxy("responses"));

  async function listModels(request: FastifyRequest) {
    const pools = await dependencies.store.getPools();
    if (isClaudeClient(request)) {
      return {
        data: pools.map((pool) => ({
          type: "model",
          id: pool.alias,
          display_name: pool.alias,
          created_at: new Date(0).toISOString(),
        })),
      };
    }
    return {
      object: "list",
      data: pools.map((pool) => ({ id: pool.alias, object: "model", created: 0, owned_by: "autoapi" })),
    };
  }
}

export function gatewayErrorHandler(diagnostic?: import("../logger/diagnostic-log.js").DiagnosticLogger) {
  return (error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof GatewayError) {
      return sendProtocolError(reply, request, error.statusCode, sanitizeErrorMessage(error.message), error.errorType);
    }
    if (error.name === "ZodError") {
      return sendProtocolError(reply, request, 400, "Invalid request payload", "invalid_request_error");
    }
    const statusCode = Number((error as Error & { statusCode?: number }).statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      const message = statusCode === 429 ? "请求过于频繁，请稍后再试" : sanitizeErrorMessage(error.message);
      return sendProtocolError(reply, request, statusCode, message, statusCode === 429 ? "rate_limited" : "request_error");
    }
    request.log.error({
      errorName: error.name,
      errorMessage: sanitizeErrorMessage(error.message),
      requestId: request.id,
      method: request.method,
      path: request.url.split("?", 1)[0],
    }, "Unhandled request error");
    diagnostic?.logSystem("error", "gateway", "未处理请求错误", {
      method: request.method,
      path: request.url.split("?", 1)[0],
      errorName: error.name,
      errorMessage: sanitizeErrorMessage(error.message),
    });
    if (request.url.startsWith("/admin/checkin")) {
      return reply.code(500).send({
        error: {
          message: sanitizeErrorMessage(error.message) || "签到请求处理失败",
          type: "checkin_error",
          requestId: request.id,
        },
      });
    }
    return sendProtocolError(reply, request, 500, "Internal gateway error", "internal_error");
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\b(api[-_ ]?key|token|authorization)\s*[:=]\s*["']?[^\s"']+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function asBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractReasoningEffort(body: Record<string, unknown>): string | null {
  const direct = typeof body.reasoning_effort === "string" ? body.reasoning_effort : null;
  const reasoning = body.reasoning;
  const nested = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
    && typeof (reasoning as Record<string, unknown>).effort === "string"
    ? (reasoning as Record<string, unknown>).effort as string
    : null;
  const value = (direct ?? nested)?.trim().toLowerCase();
  return value ? value.slice(0, 40) : null;
}

function clientName(request: FastifyRequest, kind: RequestKind): string {
  const explicit = request.headers["x-autoapi-client"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.slice(0, 120);

  const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
  if (/cli[-_ ]?proxy[-_ ]?api|cliproxyapi|\bcpa\b/i.test(userAgent)) return "cli-proxy-api";
  if (/claude[-_ ]?code/i.test(userAgent)) return "claude-code";
  if (/\bcodex\b|openai-codex/i.test(userAgent)) return "codex";
  if (/\bhermes\b/i.test(userAgent)) return "hermes";
  if (/\bopencode\b/i.test(userAgent)) return "opencode";
  if (/python[-_ ]?requests|python[-_ ]?http/i.test(userAgent)) return "python-requests";
  if (/curl\/|wget\//i.test(userAgent)) return userAgent.slice(0, 120);
  if (/\/codex(?:\/|$)/i.test(request.url)) return "codex";
  if (isClaudePath(request.url) || kind === "messages") return "claude-code";
  return userAgent.slice(0, 120) || "unknown";
}

function protocolHeaders(request: FastifyRequest): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, raw] of Object.entries(request.headers)) {
    if (typeof raw !== "string") continue;
    const lower = name.toLowerCase();
    if (
      lower === "anthropic-version" ||
      lower === "anthropic-beta" ||
      lower === "anthropic-dangerous-direct-browser-access" ||
      lower === "openai-beta" ||
      lower === "openai-organization" ||
      lower === "openai-project" ||
      lower === "user-agent" ||
      lower.startsWith("x-stainless-")
    ) {
      selected[lower] = raw.slice(0, 500);
    }
  }
  return selected;
}

function isClaudeClient(request: FastifyRequest): boolean {
  const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";
  return /\bclaude(?:[-_ ]?code)?\b|anthropic/i.test(userAgent)
    || typeof request.headers["anthropic-version"] === "string"
    || typeof request.headers["anthropic-beta"] === "string";
}

function endpointForKind(kind: RequestKind): string {
  return kind === "responses" ? "/responses" : kind === "messages" ? "/messages" : "/chat/completions";
}

async function sendResult(reply: FastifyReply, result: UpstreamResult) {
  reply.code(result.status);
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  reply.header("x-autoapi-channel", result.channelId);
  if (result.body instanceof Uint8Array) return reply.send(Buffer.from(result.body));

  reply.hijack();
  reply.raw.writeHead(result.status, {
    ...result.headers,
    "x-autoapi-channel": result.channelId,
    connection: "keep-alive",
  });
  for await (const chunk of result.body) {
    if (reply.raw.destroyed || reply.raw.writableEnded) break;
    if (!reply.raw.write(chunk) && !(await waitForDrain(reply))) break;
  }
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  return reply;
}

function waitForDrain(reply: FastifyReply): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      reply.raw.off("drain", onDrain);
      reply.raw.off("close", onClose);
      reply.raw.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    reply.raw.once("drain", onDrain);
    reply.raw.once("close", onClose);
    reply.raw.once("error", onClose);
  });
}

function sendProtocolError(reply: FastifyReply, request: FastifyRequest, status: number, message: string, type: string) {
  return reply.code(status).send(isClaudePath(request.url)
    ? { type: "error", error: { type, message } }
    : { error: { message, type } });
}
