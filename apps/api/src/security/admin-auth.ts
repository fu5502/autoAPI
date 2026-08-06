import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { AdminAccount, AdminLoginRecord } from "../domain/types.js";
import type { GatewayStore } from "../domain/store.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface Session {
  username: string;
  expiresAt: number;
}

export class AdminAuthService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly store: GatewayStore, private readonly legacyToken: string) {}

  async ensureAccount(username: string, password: string): Promise<AdminAccount> {
    const existing = await this.store.getAdminAccount();
    if (existing) return existing;
    const now = new Date().toISOString();
    return this.store.saveAdminAccount({
      username,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
    });
  }

  async login(username: string, password: string, request: FastifyRequest) {
    const account = await this.store.getAdminAccount();
    const valid = Boolean(account && account.username === username && verifyPassword(password, account.passwordHash));
    await this.store.recordAdminLogin({
      username,
      ip: requestIp(request),
      userAgent: request.headers["user-agent"] ?? "unknown",
      success: valid,
      reason: valid ? null : "invalid_credentials",
      createdAt: new Date().toISOString(),
    });
    if (!valid || !account) return null;

    return this.issueSession(account.username);
  }

  isValidToken(token: string): boolean {
    if (!token) return false;
    for (const [sessionToken, session] of this.sessions) {
      if (session.expiresAt <= Date.now()) this.sessions.delete(sessionToken);
    }
    if (token.startsWith("autoapi_session_")) return this.sessions.has(token);
    return constantTimeEqual(token, this.legacyToken);
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const account = await this.store.getAdminAccount();
    if (!account || !verifyPassword(currentPassword, account.passwordHash)) return null;
    await this.store.saveAdminAccount({
      ...account,
      passwordHash: hashPassword(newPassword),
      updatedAt: new Date().toISOString(),
    });
    this.sessions.clear();
    return this.issueSession(account.username);
  }

  private issueSession(username: string) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const token = `autoapi_session_${randomBytes(32).toString("base64url")}`;
    this.sessions.set(token, { username, expiresAt });
    return { token, username, expiresAt: new Date(expiresAt).toISOString() };
  }
}

export function requestIp(request: FastifyRequest): string {
  const directIp = request.ip || request.socket.remoteAddress || "";
  return isIP(directIp) ? directIp : "0.0.0.0";
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
