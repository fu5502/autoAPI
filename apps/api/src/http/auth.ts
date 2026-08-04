import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GatewayStore } from "../domain/store.js";
import { hashGatewayKey } from "../security/gateway-key.js";

export function requireToken(expected: string, kind: "admin" | "gateway") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actual = readAccessToken(request, kind);
    if (!constantTimeEqual(actual, expected)) {
      return reply.code(401).send(authErrorPayload(request, "Invalid or missing access token"));
    }
  };
}

export function requireGatewayToken(store: GatewayStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actual = readAccessToken(request, "gateway");
    if (!actual || !(await store.hasGatewayKey(hashGatewayKey(actual)))) {
      return reply.code(401).send(authErrorPayload(request, "Invalid or missing access token"));
    }
  };
}

function readAccessToken(request: FastifyRequest, kind: "admin" | "gateway"): string {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, "").trim()
    : "";
  if (bearer) return bearer;

  const names = kind === "admin" ? ["x-admin-token"] : ["x-api-key", "api-key"];
  for (const name of names) {
    const value = request.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function authErrorPayload(request: FastifyRequest, message: string) {
  return isClaudePath(request.url)
    ? { type: "error", error: { type: "authentication_error", message } }
    : { error: { message, type: "authentication_error" } };
}

export function isClaudePath(url: string): boolean {
  return /^\/(?:anthropic|claude)?\/?v1\/messages(?:[/?]|$)/i.test(url.split("?", 1)[0] ?? "")
    || /^\/(?:anthropic|claude)\/messages(?:[/?]|$)/i.test(url.split("?", 1)[0] ?? "");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
