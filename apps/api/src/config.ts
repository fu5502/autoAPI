import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().default("postgres://autoapi:autoapi@localhost:5432/autoapi"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ADMIN_TOKEN: z.string().min(8).default("change-me-admin"),
  ADMIN_USERNAME: z.string().trim().min(1).max(80).default("admin"),
  ADMIN_PASSWORD: z.string().min(8).default("AutoAPI@123456"),
  GATEWAY_API_KEY: z.string().min(8).default("change-me-gateway"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(8).default("change-me-in-development-only"),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  TRUST_PROXY: z.string().trim().default("false"),
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(5 * 60_000),
  APP_MODE: z.enum(["production", "demo"]).default("demo"),
  DATA_DIR: z.string().trim().min(1).default(".autoapi-data"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  CHECKIN_ENABLE_NOVNC: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  if (parsed.NODE_ENV === "production") {
    const unsafe = [parsed.ADMIN_TOKEN, parsed.GATEWAY_API_KEY, parsed.CREDENTIAL_ENCRYPTION_KEY, parsed.ADMIN_PASSWORD]
      .some(isPlaceholderValue)
      || hasUnsafeDatabaseCredentials(parsed.DATABASE_URL);
    if (unsafe) throw new Error("Production secrets must be configured before startup");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    adminToken: parsed.ADMIN_TOKEN,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    gatewayApiKey: parsed.GATEWAY_API_KEY,
    credentialEncryptionKey: parsed.CREDENTIAL_ENCRYPTION_KEY,
    healthCheckIntervalMs: parsed.HEALTH_CHECK_INTERVAL_MS,
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
    failureThreshold: parsed.FAILURE_THRESHOLD,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    adminLoginRateLimitMax: parsed.ADMIN_LOGIN_RATE_LIMIT_MAX,
    adminLoginRateLimitWindowMs: parsed.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
    appMode: parsed.APP_MODE,
    dataDir: parsed.DATA_DIR,
    checkinEnableNoVnc: parsed.CHECKIN_ENABLE_NOVNC,
    gatewayBaseUrl: `${(parsed.PUBLIC_BASE_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/+$/, "")}/v1`,
  } as const;
}

function parseTrustProxy(value: string): boolean | string[] {
  const normalized = value.toLowerCase();
  if (!value || normalized === "false") return false;
  if (normalized === "true") return true;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "autoapi@123456"
    || normalized === "autoapi"
    || /^(?:change[-_ ]?me|replace(?:[-_ ]?with)?|your[-_ ])/i.test(normalized);
}

function hasUnsafeDatabaseCredentials(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return !url.password || isPlaceholderValue(decodeURIComponent(url.password));
  } catch {
    return true;
  }
}
