import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
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
import { MemoryRuntimeState, RedisRuntimeState, type RuntimeState } from "./runtime/runtime-state.js";
import { createSecretBox } from "./security/secret-box.js";
import { hashGatewayKey } from "./security/gateway-key.js";
import { AdminAuthService } from "./security/admin-auth.js";

export interface BuildAppOptions {
  config?: AppConfig;
  store?: GatewayStore;
  runtime?: RuntimeState;
  startAgent?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : {
      level: config.nodeEnv === "production" ? "info" : "warn",
      redact: ["req.headers.authorization", "req.headers.x-api-key", "req.headers.x-admin-token", "body.apiKey"],
    },
    requestTimeout: config.upstreamTimeoutMs + 10_000,
    bodyLimit: 10 * 1024 * 1024,
  });
  app.setErrorHandler(gatewayErrorHandler);
  await app.register(cors, { origin: config.nodeEnv === "production" ? false : true });

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
    await store.createGatewayKey("环境变量密钥", hashGatewayKey(config.gatewayApiKey), config.gatewayApiKey.slice(-4));
  }
  const adminAuth = new AdminAuthService(store, config.adminToken);
  await adminAuth.ensureAccount(config.adminUsername, config.adminPassword);
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
  });
  const agent = new OpsAgent({
    store,
    registry,
    secrets,
    timeoutMs: config.upstreamTimeoutMs,
    failureThreshold: config.failureThreshold,
    intervalMs: config.healthCheckIntervalMs,
  });

  app.get("/healthz", async () => ({ status: "ok", mode: config.appMode, timestamp: new Date().toISOString() }));
  await registerAdminRoutes(app, { store, agent, router, adminAuth, gatewayBaseUrl: config.gatewayBaseUrl });
  await registerProxyRoutes(app, { router, store });

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
  }

  app.addHook("onClose", async () => {
    agent.stop();
    await Promise.all([store.close(), runtime.close()]);
  });
  if (options.startAgent !== false && config.appMode === "production") agent.start();

  return { app, store, runtime, router, agent, config };
}

async function connectProductionStore(connectionString: string): Promise<PostgresStore> {
  const store = await PostgresStore.connect(connectionString);
  await store.migrate();
  return store;
}
