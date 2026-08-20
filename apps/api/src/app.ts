import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { OpsAgent } from "./agent/ops-agent.js";
import { loadConfig, type AppConfig } from "./config.js";
import { MemoryStore, PersistentMemoryStore } from "./db/memory-store.js";
import { PostgresStore } from "./db/postgres-store.js";
import type { GatewayStore } from "./domain/store.js";
import { AdapterRegistry } from "./gateway/adapter.js";
import { ClaudeAdapter } from "./gateway/adapters/claude-adapter.js";
import { GeminiAdapter } from "./gateway/adapters/gemini-adapter.js";
import { OpenAiAdapter } from "./gateway/adapters/openai-adapter.js";
import { GatewayRouter } from "./gateway/router.js";
import { registerAdminRoutes } from "./http/admin-routes.js";
import { gatewayErrorHandler, registerProxyRoutes } from "./http/proxy-routes.js";
import { DiagnosticLogger } from "./logger/diagnostic-log.js";
import { MemoryRuntimeState, RedisRuntimeState, type RuntimeState } from "./runtime/runtime-state.js";
import { createSecretBox } from "./security/secret-box.js";
import { hashGatewayKey } from "./security/gateway-key.js";
import { AdminAuthService } from "./security/admin-auth.js";
import { createCheckinModule, registerCheckinRoutes, type CheckinModule } from "./checkin/module.js";
import { registerBrowserProxy, type BrowserProxyController } from "./checkin/browser-proxy.js";
import { registerCompressedJsonParser } from "./http/compressed-json.js";

export interface BuildAppOptions {
  config?: AppConfig;
  store?: GatewayStore;
  runtime?: RuntimeState;
  startAgent?: boolean;
  startCheckin?: boolean;
  version?: string;
  diagnostic?: DiagnosticLogger;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const version = options.version ?? resolveVersion();
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : {
      level: config.nodeEnv === "production" ? "info" : "warn",
    redact: ["req.headers.authorization", "req.headers.x-api-key", "req.headers.x-admin-token", "req.headers.x-autoapi-pairing-token", "req.headers.x-autoapi-assistant-token", "body.apiKey", "body.uploadToken"],
    },
    // Streaming requests are governed by the upstream connection/idle timeout
    // in fetchUpstream. A fixed Fastify request timeout would cut long Codex
    // responses even while upstream data is still arriving.
    requestTimeout: 0,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });
  registerCompressedJsonParser(app);
  const diagnostic = options.diagnostic ?? (config.nodeEnv === "test" ? undefined : new DiagnosticLogger(config.dataDir, config.logRetentionDays));
  app.setErrorHandler(gatewayErrorHandler(diagnostic));
  await app.register(cors, {
    origin: config.nodeEnv === "production"
      ? (origin, callback) => {
          if (!origin || /^(?:chrome-extension:\/\/[a-z]{32}|moz-extension:\/\/[0-9a-f-]{36})$/i.test(origin)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        }
      : true,
  });
  await app.register(rateLimit, { global: false });

  const secrets = createSecretBox(config.credentialEncryptionKey);
  const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const dataFile = isAbsolute(config.dataDir)
    ? resolve(config.dataDir, "state.json")
    : resolve(projectRoot, config.dataDir, "state.json");
  const legacyDataFile = config.dataDir === ".autoapi-data"
    ? resolve(projectRoot, "apps/api/.autoapi-data/state.json")
    : undefined;
  const store = options.store ?? (config.appMode === "demo"
    ? config.nodeEnv === "test"
      ? new MemoryStore()
      : await PersistentMemoryStore.fromFile(dataFile, legacyDataFile)
    : await connectProductionStore(config.databaseUrl));
  if ((await store.listGatewayKeys()).length === 0) {
    await store.createGatewayKey("环境变量密钥", hashGatewayKey(config.gatewayApiKey), config.gatewayApiKey.slice(-4), secrets.encrypt(config.gatewayApiKey));
  }
  const adminAuth = new AdminAuthService(store, config.adminToken);
  await adminAuth.ensureAccount(config.adminUsername, config.adminPassword);
  const startCheckin = options.startCheckin ?? config.nodeEnv !== "test";
  const checkin = startCheckin
    ? createCheckinModule(store, { interactiveAuthorizationEnabled: config.checkinEnableNoVnc, secrets })
    : null;
  let browserProxy: BrowserProxyController | null = null;
  const runtime = options.runtime ?? (config.appMode === "demo"
    ? new MemoryRuntimeState()
    : await RedisRuntimeState.connect(config.redisUrl));
  const registry = new AdapterRegistry([new OpenAiAdapter(), new ClaudeAdapter(), new GeminiAdapter()]);
  const router = new GatewayRouter({
    store,
    registry,
    secrets,
    runtime,
    timeoutMs: config.upstreamTimeoutMs,
    failureThreshold: config.failureThreshold,
    ...(diagnostic ? { diagnostic } : {}),
  });
  const agent = new OpsAgent({
    store,
    registry,
    secrets,
    timeoutMs: config.upstreamTimeoutMs,
    failureThreshold: config.failureThreshold,
    intervalMs: config.healthCheckIntervalMs,
    ...(diagnostic ? { diagnostic } : {}),
  });

  if (checkin) void checkin.balanceSync.syncAll().catch(() => undefined);

  app.get("/healthz", async () => ({ status: "ok", mode: config.appMode, version, timestamp: new Date().toISOString() }));
  app.get("/latest-version", async () => ({ latest: await fetchLatestVersion(), current: version }));
  if (diagnostic) {
    diagnostic.startAutoCleanup(config.logCleanupIntervalMs);
    void diagnostic.init().then(() => diagnostic.logSystem("info", "system", "服务启动", {
      version,
      mode: config.appMode,
      nodeEnv: config.nodeEnv,
      dataDir: config.dataDir,
      logRetentionDays: config.logRetentionDays,
    })).catch(() => undefined);
  }
  await registerAdminRoutes(app, {
    store,
    agent,
    secrets,
    router,
    adminAuth,
    gatewayBaseUrl: config.gatewayBaseUrl,
    publicBaseUrl: config.publicBaseUrl,
    version,
    loginRateLimitMax: config.adminLoginRateLimitMax,
    loginRateLimitWindowMs: config.adminLoginRateLimitWindowMs,
    checkinDb: checkin?.db,
    siteIcons: checkin?.siteIcons,
    checkin: checkin ? { db: checkin.db, coordinator: checkin.coordinator } : undefined,
    diagnostic,
  });
  if (checkin) {
    await registerCheckinRoutes(app, checkin, async (request, reply) => {
      const authorization = request.headers.authorization;
      const bearer = typeof authorization === "string" && /^Bearer\s+/i.test(authorization)
        ? authorization.replace(/^Bearer\s+/i, "").trim()
        : typeof request.headers["x-admin-token"] === "string" ? request.headers["x-admin-token"].trim() : "";
      if (!adminAuth.isValidToken(bearer)) {
        await reply.code(401).send({ error: { message: "登录已失效，请重新登录", type: "authentication_error" } });
        return;
      }
    }, { agent });
    if (config.checkinEnableNoVnc) {
      browserProxy = await registerBrowserProxy(app, (token) => adminAuth.isValidToken(token));
    }
  }
  await registerProxyRoutes(app, { router, store });

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
  }

  app.addHook("onClose", async () => {
    diagnostic?.stopAutoCleanup();
    if (diagnostic) {
      void diagnostic.logSystem("info", "system", "服务关闭", { version }).catch(() => undefined);
    }
    agent.stop();
    browserProxy?.close();
    await Promise.all([store.close(), runtime.close(), checkin?.close()]);
  });
  if (options.startAgent === true) agent.start();

  return { app, store, runtime, router, agent, checkin, config };
}

async function connectProductionStore(connectionString: string): Promise<PostgresStore> {
  const store = await PostgresStore.connect(connectionString);
  await store.migrate();
  return store;
}

function resolveVersion(): string {
  if (process.env.AUTOAPI_VERSION?.trim()) return process.env.AUTOAPI_VERSION.trim();
  try {
    const packageJsonPath = new URL("../../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Cached latest version from GitHub repo package.json (5 min TTL).
let latestVersionCache: { value: string | null; fetchedAt: number } | null = null;
const LATEST_VERSION_TTL_MS = 5 * 60_000;

async function fetchLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (latestVersionCache && now - latestVersionCache.fetchedAt < LATEST_VERSION_TTL_MS) {
    return latestVersionCache.value;
  }
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "autoapi-version-check",
    };
    // Private repo requires a token; GITHUB_TOKEN is typically set in the
    // deployment environment. Without it the API returns 404 and we silently
    // skip the update check.
    const githubToken = process.env.GITHUB_TOKEN?.trim();
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    const response = await fetch("https://api.github.com/repos/fu5502/autoAPI/contents/package.json", {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const data = await response.json() as { content?: string; encoding?: string };
    if (typeof data.content !== "string" || data.encoding !== "base64") throw new Error("Unexpected GitHub response");
    const decoded = Buffer.from(data.content, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { version?: string };
    const value = parsed.version ?? null;
    latestVersionCache = { value, fetchedAt: now };
    return value;
  } catch {
    if (latestVersionCache) return latestVersionCache.value;
    return null;
  }
}
