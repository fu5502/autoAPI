import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const BROWSER_PREFIX = "/admin/checkin/browser";
const WEBSOCKET_PATH = `${BROWSER_PREFIX}/websockify`;
const SESSION_COOKIE = "autoapi_checkin_browser";
const SESSION_TTL_MS = 10 * 60_000;
const TARGET_URL = "http://127.0.0.1:6080";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface BrowserProxyController {
  close(): void;
  createSessionCookie(): { cookie: string; url: string };
}

export async function registerBrowserProxy(
  app: FastifyInstance,
  isValidAdminToken: (token: string) => boolean,
): Promise<BrowserProxyController> {
  const proxy = new BrowserProxy(app.server);

  app.post("/admin/checkin/browser/session", async (request, reply) => {
    if (!isValidAdminToken(readAdminToken(request))) {
      return reply.code(401).send({ error: { message: "登录已失效，请重新登录", type: "authentication_error" } });
    }
    const session = proxy.createSessionCookie();
    reply.header("set-cookie", session.cookie);
    return { url: session.url };
  });

  app.all<{ Params: { "*": string } }>(`${BROWSER_PREFIX}/*`, async (request, reply) => {
    if (!proxy.isValidSession(readCookie(request.headers.cookie))) {
      return reply.code(401).send({ error: { message: "浏览器授权会话已过期，请重新打开授权窗口", type: "authentication_error" } });
    }
    return proxy.forwardHttp(request, reply);
  });

  app.server.on("upgrade", proxy.handleUpgrade);
  return proxy;
}

class BrowserProxy implements BrowserProxyController {
  private readonly sessions = new Map<string, number>();
  private readonly target = new URL(TARGET_URL);
  readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split("?", 1)[0] !== WEBSOCKET_PATH) return;
    if (!this.isValidSession(readCookie(request.headers.cookie))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    this.forwardWebSocket(request, socket, head);
  };

  constructor(private readonly server: Server) {}

  createSessionCookie() {
    this.cleanup();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return {
      cookie: `${SESSION_COOKIE}=${token}; Path=${BROWSER_PREFIX}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict`,
      url: `${BROWSER_PREFIX}/vnc.html?autoconnect=true&resize=scale&path=${encodeURIComponent(WEBSOCKET_PATH.slice(1))}`,
    };
  }

  isValidSession(token: string) {
    this.cleanup();
    return Boolean(token && this.sessions.has(token));
  }

  close() {
    this.server.off("upgrade", this.handleUpgrade);
    this.sessions.clear();
  }

  async forwardHttp(request: FastifyRequest, reply: FastifyReply) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("allow", "GET, HEAD").send({ error: { message: "只允许读取浏览器页面资源", type: "method_not_allowed" } });
    }

    const requestUrl = new URL(request.raw.url ?? "/", "http://autoapi.local");
    const targetPath = requestUrl.pathname.slice(BROWSER_PREFIX.length) || "/";
    if (!targetPath.startsWith("/")) {
      return reply.code(400).send({ error: { message: "无效的浏览器资源路径", type: "invalid_request_error" } });
    }

    reply.hijack();
    await new Promise<void>((resolve) => {
      const upstream = httpRequest({
        hostname: this.target.hostname,
        port: Number(this.target.port),
        method: request.method,
        path: `${targetPath}${requestUrl.search}`,
        headers: { host: this.target.host },
      }, (response) => {
        const headers = filterHeaders(response.headers);
        reply.raw.writeHead(response.statusCode ?? 502, response.statusMessage, headers);
        response.once("end", resolve);
        response.once("close", resolve);
        response.pipe(reply.raw);
      });
      upstream.once("error", () => {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          reply.raw.end("浏览器授权服务暂不可用");
        } else {
          reply.raw.destroy();
        }
        resolve();
      });
      upstream.end();
    });
  }

  private forwardWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const requestUrl = new URL(request.url ?? WEBSOCKET_PATH, "http://autoapi.local");
    const upstream = httpRequest({
      hostname: this.target.hostname,
      port: Number(this.target.port),
      method: "GET",
      path: `/websockify${requestUrl.search}`,
      headers: {
        ...request.headers,
        host: this.target.host,
      },
    });

    upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
      const headers = filterHeaders(response.headers, true);
      socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`);
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) socket.write(`${name}: ${item}\r\n`);
        } else if (value !== undefined) {
          socket.write(`${name}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.once("error", () => socket.destroy());
      socket.once("error", () => upstreamSocket.destroy());
    });
    upstream.once("response", (response) => {
      const headers = filterHeaders(response.headers);
      socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\n`);
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) socket.write(`${name}: ${item}\r\n`);
        } else if (value !== undefined) {
          socket.write(`${name}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      response.pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    upstream.end();
  }

  private cleanup() {
    const now = Date.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}

function readAdminToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  const legacy = request.headers["x-admin-token"];
  return typeof legacy === "string" ? legacy.trim() : "";
}

function readCookie(header: string | undefined): string {
  if (!header) return "";
  for (const item of header.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === SESSION_COOKIE) return parts.join("=");
  }
  return "";
}

function filterHeaders(headers: Record<string, string | string[] | undefined>, preserveUpgrade = false) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lowerName = name.toLowerCase();
    return preserveUpgrade
      ? lowerName !== "transfer-encoding" && lowerName !== "keep-alive"
      : !HOP_BY_HOP_HEADERS.has(lowerName);
  }));
}
