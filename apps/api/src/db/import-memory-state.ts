import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import type {
  AdminAccount,
  AdminLoginRecord,
  Channel,
  GatewayKey,
  ModelRoute,
  PlaygroundSession,
  UsageEventInput,
} from "../domain/types.js";
import { hashGatewayKey } from "../security/gateway-key.js";
import { createSecretBox } from "../security/secret-box.js";

type PersistedUsage = UsageEventInput & { createdAt: string };

interface PersistedMemoryState {
  version: number;
  channels: Channel[];
  routes: ModelRoute[];
  usage: PersistedUsage[];
  gatewayKeys: GatewayKey[];
  playgroundSessions: PlaygroundSession[];
  adminAccount: AdminAccount | undefined;
  adminLoginHistory: AdminLoginRecord[];
}

interface ImportCounts {
  channels: number;
  routes: number;
  usage: number;
  gatewayKeys: number;
  playgroundSessions: number;
  adminLoginHistory: number;
}

async function main() {
  const statePath = process.argv[2];
  const connectionString = process.env.DATABASE_URL;
  if (!statePath) throw new Error("Usage: import-memory-state <state.json>");
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const sourceCredentialKey = process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
  const targetCredentialKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const gatewayApiKey = process.env.GATEWAY_API_KEY;
  const prepared = prepareState(parseState(await readFile(statePath, "utf8")), {
    sourceCredentialKey,
    targetCredentialKey,
    gatewayApiKey,
  });
  const pool = new Pool({ connectionString, max: 2 });
  try {
    await migrateSchema(pool);
    const result = await importState(pool, prepared.state);
    console.log(JSON.stringify({ ...result, ...prepared.changes }));
  } finally {
    await pool.end();
  }
}

export function parseState(raw: string): PersistedMemoryState {
  const state = JSON.parse(raw) as Partial<PersistedMemoryState>;
  if (!Array.isArray(state.channels) || !Array.isArray(state.routes) || !Array.isArray(state.usage)) {
    throw new Error("Invalid memory state: channels, routes and usage must be arrays");
  }
  return {
    version: Number(state.version ?? 0),
    channels: state.channels,
    routes: state.routes,
    usage: state.usage,
    gatewayKeys: Array.isArray(state.gatewayKeys) ? state.gatewayKeys : [],
    playgroundSessions: Array.isArray(state.playgroundSessions) ? state.playgroundSessions : [],
    adminAccount: state.adminAccount,
    adminLoginHistory: Array.isArray(state.adminLoginHistory) ? state.adminLoginHistory : [],
  };
}

export function prepareState(
  state: PersistedMemoryState,
  options: {
    sourceCredentialKey?: string | undefined;
    targetCredentialKey?: string | undefined;
    gatewayApiKey?: string | undefined;
  },
): {
  state: PersistedMemoryState;
  changes: {
    credentialsReencrypted: number;
    developmentGatewayKeysRotated: number;
    orphanedUsageChannelRefsCleared: number;
    orphanedSessionChannelRefsCleared: number;
  };
} {
  let credentialsReencrypted = 0;
  let developmentGatewayKeysRotated = 0;
  let orphanedUsageChannelRefsCleared = 0;
  let orphanedSessionChannelRefsCleared = 0;
  let channels = state.channels;
  let gatewayKeys = state.gatewayKeys;

  if (options.sourceCredentialKey) {
    if (!options.targetCredentialKey) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY is required when SOURCE_CREDENTIAL_ENCRYPTION_KEY is set");
    }
    const source = createSecretBox(options.sourceCredentialKey);
    const target = createSecretBox(options.targetCredentialKey);
    channels = state.channels.map((channel) => {
      const plaintext = source.decrypt(channel.keyCiphertext);
      credentialsReencrypted += 1;
      return { ...channel, keyCiphertext: target.encrypt(plaintext) };
    });
  }

  if (options.gatewayApiKey) {
    const developmentHash = hashGatewayKey("change-me-gateway");
    gatewayKeys = state.gatewayKeys.map((key) => {
      if (key.keyHash !== developmentHash) return key;
      developmentGatewayKeysRotated += 1;
      return {
        ...key,
        keyHash: hashGatewayKey(options.gatewayApiKey!),
        keyLast4: options.gatewayApiKey!.slice(-4),
        lastUsedAt: null,
      };
    });
  }

  const channelIds = new Set(channels.map((channel) => channel.id));
  const usage = state.usage.map((event) => {
    if (!event.channelId || channelIds.has(event.channelId)) return event;
    orphanedUsageChannelRefsCleared += 1;
    return { ...event, channelId: null };
  });
  const playgroundSessions = state.playgroundSessions.map((session) => {
    if (!session.channelId || channelIds.has(session.channelId)) return session;
    orphanedSessionChannelRefsCleared += 1;
    return { ...session, channelId: null };
  });

  return {
    state: { ...state, channels, usage, gatewayKeys, playgroundSessions },
    changes: {
      credentialsReencrypted,
      developmentGatewayKeysRotated,
      orphanedUsageChannelRefsCleared,
      orphanedSessionChannelRefsCleared,
    },
  };
}

async function migrateSchema(pool: Pool) {
  const migrationUrl = new URL("../../migrations/001_init.sql", import.meta.url);
  await pool.query(await readFile(migrationUrl, "utf8"));
}

async function importState(pool: Pool, state: PersistedMemoryState) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('autoapi-memory-state-import'))");
    const existing = await readCounts(client);
    if (existing.channels || existing.routes || existing.usage || existing.playgroundSessions) {
      throw new Error(`Target database already contains business data: ${JSON.stringify(existing)}`);
    }

    await insertProvidersAndChannels(client, state.channels);
    await insertRoutes(client, state.routes);
    await insertUsage(client, state.usage);
    await insertGatewayKeys(client, state.gatewayKeys);
    await insertPlaygroundSessions(client, state.playgroundSessions);
    await insertAdminAccount(client, state.adminAccount);
    await insertLoginHistory(client, state.adminLoginHistory);

    const imported = await readCounts(client);
    assertImportedCounts(state, imported);
    await client.query("COMMIT");
    return { ok: true, sourceVersion: state.version, imported };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readCounts(client: PoolClient): Promise<ImportCounts> {
  const result = await client.query<ImportCounts>(`
    SELECT
      (SELECT count(*)::int FROM channels) AS channels,
      (SELECT count(*)::int FROM model_aliases) AS routes,
      (SELECT count(*)::int FROM usage_events) AS usage,
      (SELECT count(*)::int FROM gateway_keys) AS "gatewayKeys",
      (SELECT count(*)::int FROM playground_sessions) AS "playgroundSessions",
      (SELECT count(*)::int FROM admin_login_history) AS "adminLoginHistory"
  `);
  return result.rows[0]!;
}

async function insertProvidersAndChannels(client: PoolClient, channels: Channel[]) {
  const providers = new Map<string, { name: string; website: string | null; tags: string[]; createdAt: string }>();
  for (const channel of channels) {
    const current = providers.get(channel.providerId);
    const tags = [...new Set([...(current?.tags ?? []), ...channel.tags])];
    providers.set(channel.providerId, {
      name: current?.name ?? channel.providerName,
      website: current?.website ?? websiteFor(channel.baseUrl),
      tags,
      createdAt: current && Date.parse(current.createdAt) < Date.parse(channel.createdAt) ? current.createdAt : channel.createdAt,
    });
  }

  for (const [id, provider] of providers) {
    await client.query(
      `INSERT INTO providers (id, name, website, tags, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, provider.name, provider.website, provider.tags, provider.createdAt],
    );
  }

  for (const channel of channels) {
    const credentialId = randomUUID();
    await client.query(
      `INSERT INTO provider_credentials
        (id, provider_id, key_ciphertext, key_name, key_last4, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [credentialId, channel.providerId, channel.keyCiphertext, channel.keyName ?? "API Key", channel.keyLast4, channel.createdAt],
    );
    await client.query(
      `INSERT INTO channels
        (id, provider_id, credential_id, name, base_url, favicon_url, protocol, status, enabled,
         priority, weight, min_balance, current_balance, balance_currency, balance_status,
         consecutive_failures, cooldown_until, isolation_reason, last_checked_at, last_latency_ms,
         available_models, tags, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20,
         $21, $22, $23, $23)`,
      [
        channel.id,
        channel.providerId,
        credentialId,
        channel.name,
        channel.baseUrl,
        channel.faviconUrl ?? null,
        channel.protocol,
        channel.status,
        channel.enabled,
        channel.priority,
        channel.weight,
        channel.minBalance,
        channel.balance,
        channel.balanceCurrency,
        channel.balanceStatus,
        channel.consecutiveFailures,
        channel.cooldownUntil,
        channel.isolationReason,
        channel.lastCheckedAt,
        channel.lastLatencyMs,
        channel.models,
        channel.tags,
        channel.createdAt,
      ],
    );
  }
}

async function insertRoutes(client: PoolClient, routes: ModelRoute[]) {
  for (const route of routes) {
    await client.query(
      `INSERT INTO model_aliases (id, alias, channel_id, upstream_model, enabled)
       VALUES ($1, $2, $3, $4, $5)`,
      [route.id, route.alias, route.channelId, route.upstreamModel, route.enabled],
    );
  }
}

async function insertUsage(client: PoolClient, usage: PersistedUsage[]) {
  for (const event of usage) {
    await client.query(
      `INSERT INTO usage_events
        (request_id, channel_id, model_alias, upstream_model, client_name, request_kind, status_code,
         prompt_tokens, completion_tokens, latency_ms, error_type, retry_count, streamed, endpoint,
         source_ip, gateway_key_name, reasoning_effort, cached_tokens, cost_usd, first_byte_latency_ms, created_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21)`,
      [
        event.requestId,
        event.channelId,
        event.modelAlias,
        event.upstreamModel,
        event.clientName,
        event.requestKind,
        event.statusCode,
        event.promptTokens,
        event.completionTokens,
        event.latencyMs,
        event.errorType,
        event.retryCount,
        event.streamed,
        event.endpoint ?? null,
        normalizeIp(event.sourceIp),
        event.gatewayKeyName ?? null,
        event.reasoningEffort ?? null,
        event.cachedTokens ?? null,
        event.costUsd ?? null,
        event.firstByteLatencyMs ?? null,
        event.createdAt,
      ],
    );
  }
}

async function insertGatewayKeys(client: PoolClient, keys: GatewayKey[]) {
  for (const key of keys) {
    await client.query(
      `INSERT INTO gateway_keys (id, name, key_hash, key_last4, enabled, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key_hash) DO UPDATE SET
         name = EXCLUDED.name,
         key_last4 = EXCLUDED.key_last4,
         enabled = EXCLUDED.enabled,
         last_used_at = EXCLUDED.last_used_at`,
      [key.id, key.name, key.keyHash, key.keyLast4, key.enabled, key.createdAt, key.lastUsedAt],
    );
  }
}

async function insertPlaygroundSessions(client: PoolClient, sessions: PlaygroundSession[]) {
  for (const session of sessions) {
    await client.query(
      `INSERT INTO playground_sessions
        (id, channel_id, channel_name, provider_name, model, temperature, top_p, max_tokens,
         frequency_penalty, presence_penalty, stream, messages, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
      [
        session.id,
        session.channelId,
        session.channelName,
        session.providerName,
        session.model,
        session.temperature,
        session.topP,
        session.maxTokens,
        session.frequencyPenalty,
        session.presencePenalty,
        session.stream ?? true,
        JSON.stringify(session.messages),
        session.createdAt,
        session.updatedAt,
      ],
    );
  }
}

async function insertAdminAccount(client: PoolClient, account?: AdminAccount) {
  if (!account) return;
  await client.query(
    `INSERT INTO admin_accounts (id, username, password_hash, created_at, updated_at)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       updated_at = EXCLUDED.updated_at`,
    [account.username, account.passwordHash, account.createdAt, account.updatedAt],
  );
}

async function insertLoginHistory(client: PoolClient, records: AdminLoginRecord[]) {
  for (const record of [...records].reverse()) {
    await client.query(
      `INSERT INTO admin_login_history (username, ip, user_agent, success, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.username, normalizeIp(record.ip) ?? "0.0.0.0", record.userAgent, record.success, record.reason, record.createdAt],
    );
  }
}

function assertImportedCounts(state: PersistedMemoryState, actual: ImportCounts) {
  const expected: ImportCounts = {
    channels: state.channels.length,
    routes: state.routes.length,
    usage: state.usage.length,
    gatewayKeys: state.gatewayKeys.length,
    playgroundSessions: state.playgroundSessions.length,
    adminLoginHistory: state.adminLoginHistory.length,
  };
  for (const key of Object.keys(expected) as Array<keyof ImportCounts>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Imported ${key} count mismatch: expected ${expected[key]}, received ${actual[key]}`);
    }
  }
}

function websiteFor(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function normalizeIp(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/^::ffff:/i, "");
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
