import { readFile } from "node:fs/promises";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { GatewayStore, ImportedProvider } from "../domain/store.js";
import type {
  Channel,
  ChannelUpdateInput,
  AdminAccount,
  AdminLoginRecord,
  GatewayKey,
  GatewayKeySummary,
  ModelAliasInput,
  PoolSummary,
  ProbeResult,
  ProviderImportInput,
  RoutingCandidate,
  UsageEventInput,
  UsageSummary,
  PlaygroundSession,
  RequestLogFilters,
  RequestLogPage,
} from "../domain/types.js";
import { createDailyHealth, createHourlyHealth, createRecentHealth, finalizeHealthPoint } from "../domain/pool-health.js";

type Db = Pool | PoolClient;

export class PostgresStore implements GatewayStore {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });
    await pool.query("SELECT 1");
    return new PostgresStore(pool);
  }

  async migrate(): Promise<void> {
    const migrationUrl = new URL("../../migrations/001_init.sql", import.meta.url);
    await this.pool.query(await readFile(migrationUrl, "utf8"));
  }

  async importProvider(
    input: ProviderImportInput,
    encryptedKey: string,
    keyLast4: string,
    keyName?: string,
  ): Promise<ImportedProvider> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const provider = await client.query<{ id: string }>(
        `INSERT INTO providers (name, website, tags) VALUES ($1, $2, $3) RETURNING id`,
        [input.name, input.website ?? null, input.tags],
      );
      const providerId = provider.rows[0]!.id;
      const credential = await client.query<{ id: string }>(
        `INSERT INTO provider_credentials (provider_id, key_ciphertext, key_name, key_last4)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [providerId, encryptedKey, input.keyName?.trim() || keyName?.trim() || "API Key", keyLast4],
      );
      const channelResult = await client.query(
        `INSERT INTO channels
          (provider_id, credential_id, name, base_url, favicon_url, protocol, priority, weight, min_balance, available_models, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          providerId,
          credential.rows[0]!.id,
          input.channelName ?? input.name,
          normalizeBaseUrl(input.baseUrl),
          input.faviconUrl ?? null,
          input.protocol,
          input.priority,
          input.weight,
          input.minBalance ?? null,
          input.models ?? [],
          input.tags,
        ],
      );
      const channelId = channelResult.rows[0]!.id as string;
      for (const model of input.models ?? []) {
        await this.upsertModelAlias(client, { alias: model, channelId, upstreamModel: model, enabled: true });
      }
      await client.query("COMMIT");
      const channel = await this.getChannel(channelId);
      if (!channel) throw new Error("Imported channel could not be loaded");
      return { providerId, channel };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getChannel(id: string): Promise<Channel | null> {
    const result = await this.pool.query(channelSelect(`${"c.id = $1"}`), [id]);
    return result.rows[0] ? mapChannel(result.rows[0]) : null;
  }

  async listChannels(): Promise<Channel[]> {
    const result = await this.pool.query(
      channelSelect("true") + ` ORDER BY
        CASE
          WHEN NOT c.enabled OR c.status IN ('disabled', 'isolated') THEN 2
          WHEN c.status = 'degraded' THEN 1
          ELSE 0
        END ASC,
        CASE WHEN coalesce(stats.requests, 0) > 0 THEN 0 ELSE 1 END ASC,
        coalesce(stats.error_rate, 1) ASC,
        coalesce(stats.requests, 0) DESC,
        c.last_latency_ms ASC NULLS LAST,
        c.priority DESC,
        c.created_at DESC`,
    );
    return result.rows.map(mapChannel);
  }

  async reorderChannels(channelIds: string[]): Promise<Channel[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ id: string }>("SELECT id FROM channels FOR UPDATE");
      const currentIds = new Set(current.rows.map((row) => String(row.id)));
      const requestedIds = new Set(channelIds);
      if (requestedIds.size !== channelIds.length || requestedIds.size !== currentIds.size || [...currentIds].some((id) => !requestedIds.has(id))) {
        throw new Error("Channel reorder must include every channel exactly once");
      }
      for (const [index, id] of channelIds.entries()) {
        await client.query("UPDATE channels SET priority = $2, updated_at = now() WHERE id = $1", [id, channelIds.length - index]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listChannels();
  }

  async updateChannel(id: string, input: ChannelUpdateInput, encryptedKey?: string, keyLast4?: string, keyName?: string): Promise<Channel | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ provider_id: string; credential_id: string; current_balance: string | null; balance_currency: string | null; favicon_url: string | null }>(
        "SELECT provider_id, credential_id, current_balance, balance_currency, favicon_url FROM channels WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (encryptedKey && keyLast4) {
        await client.query(
          "UPDATE provider_credentials SET key_ciphertext = $2, key_name = $3, key_last4 = $4, rotated_at = now() WHERE id = $1",
          [row.credential_id, encryptedKey, input.keyName?.trim() || keyName?.trim() || "API Key", keyLast4],
        );
      } else if (input.keyName !== undefined || keyName !== undefined) {
        await client.query(
          "UPDATE provider_credentials SET key_name = $2 WHERE id = $1",
          [row.credential_id, input.keyName?.trim() || keyName?.trim() || "API Key"],
        );
      }
      const balance = input.balance === undefined ? (row.current_balance === null ? null : Number(row.current_balance)) : input.balance;
      const balanceCurrency = input.balanceCurrency === undefined ? row.balance_currency : input.balanceCurrency;
      const faviconUrl = input.faviconUrl === undefined ? row.favicon_url : input.faviconUrl;
      await client.query(
        `UPDATE channels SET
          name = $2, base_url = $3, favicon_url = $4, protocol = $5, priority = $6, weight = $7,
          min_balance = $8, available_models = $9, tags = $10,
          enabled = $11, status = CASE WHEN $11 THEN 'pending' ELSE 'disabled' END,
          consecutive_failures = 0, cooldown_until = NULL, isolation_reason = NULL,
          last_checked_at = NULL, last_latency_ms = NULL, current_balance = $12,
          balance_currency = $13, balance_status = $14, updated_at = now()
         WHERE id = $1`,
        [id, input.name, normalizeBaseUrl(input.baseUrl), faviconUrl, input.protocol, input.priority, input.weight, input.minBalance, input.models, input.tags, input.enabled ?? true, balance, balanceCurrency, getBalanceStatus(balance, input.minBalance)],
      );
      await client.query(
        `UPDATE model_aliases SET enabled = false
         WHERE channel_id = $1 AND alias = upstream_model
           AND NOT (upstream_model = ANY($2::text[]))`,
        [id, input.models],
      );
      for (const model of input.models) {
        await this.upsertModelAlias(client, { alias: model, channelId: id, upstreamModel: model, enabled: true });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getChannel(id);
  }

  async updateChannelBalance(id: string, balance: number, balanceCurrency: string | null): Promise<Channel | null> {
    await this.pool.query(
      `UPDATE channels SET
        current_balance = $2,
        balance_currency = $3,
        balance_status = CASE
          WHEN $2 <= 0 THEN 'exhausted'
          WHEN min_balance IS NOT NULL AND $2 < min_balance THEN 'low'
          ELSE 'ok'
        END,
        updated_at = now()
       WHERE id = $1`,
      [id, balance, balanceCurrency],
    );
    return this.getChannel(id);
  }

  async deleteChannel(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ provider_id: string; credential_id: string }>(
        "SELECT provider_id, credential_id FROM channels WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("DELETE FROM channels WHERE id = $1", [id]);
      await client.query(
        "DELETE FROM provider_credentials WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM channels WHERE credential_id = $1)",
        [row.credential_id],
      );
      await client.query(
        "DELETE FROM providers WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM channels WHERE provider_id = $1)",
        [row.provider_id],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<Channel | null> {
    await this.pool.query(
      `UPDATE channels SET enabled = $2, status = CASE WHEN $2 THEN 'pending' ELSE 'disabled' END,
       consecutive_failures = 0, cooldown_until = NULL, isolation_reason = NULL,
       last_checked_at = NULL, last_latency_ms = NULL, updated_at = now() WHERE id = $1`,
      [id, enabled],
    );
    return this.getChannel(id);
  }

  async listRoutingCandidates(modelAlias: string): Promise<RoutingCandidate[]> {
    const result = await this.pool.query(
      `${channelSelect("ma.alias = $1 AND ma.enabled = true", true)}
       ORDER BY c.priority DESC, c.weight DESC, c.last_latency_ms ASC NULLS LAST`,
      [modelAlias],
    );
    return result.rows.map((row) => ({ channel: mapChannel(row), upstreamModel: String(row.upstream_model) }));
  }

  async saveModelAlias(input: ModelAliasInput): Promise<void> {
    await this.upsertModelAlias(this.pool, input);
  }

  async applyProbeResult(channelId: string, result: ProbeResult, failureThreshold: number): Promise<Channel> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ consecutive_failures: number; min_balance: string | null }>(
        "SELECT consecutive_failures, min_balance FROM channels WHERE id = $1 FOR UPDATE",
        [channelId],
      );
      if (!current.rows[0]) throw new Error("Channel not found");
      const failures = result.ok ? 0 : current.rows[0].consecutive_failures + 1;
      const minBalance = current.rows[0].min_balance === null ? null : Number(current.rows[0].min_balance);
      const balanceExhausted = result.balance !== null && minBalance !== null && result.balance < minBalance;
      const isolated = balanceExhausted || (!result.ok && failures >= failureThreshold);
      const status = result.ok && !balanceExhausted ? "healthy" : isolated ? "isolated" : "degraded";
      const reason = balanceExhausted ? "balance_below_minimum" : result.error;

      await client.query(
        `UPDATE channels SET
          protocol = CASE WHEN protocol = 'auto' THEN $2 ELSE protocol END,
          status = $3,
          consecutive_failures = $4,
          cooldown_until = CASE WHEN $5 THEN now() + interval '5 minutes' ELSE NULL END,
          isolation_reason = $6,
          last_checked_at = now(),
          last_latency_ms = $7,
          current_balance = CASE WHEN $8::numeric IS NULL THEN current_balance ELSE $8 END,
          balance_currency = CASE WHEN $8::numeric IS NULL THEN balance_currency ELSE $9 END,
          balance_status = CASE WHEN $8::numeric IS NULL THEN balance_status ELSE $10 END,
          updated_at = now()
         WHERE id = $1`,
        [
          channelId,
          result.protocol,
          status,
          failures,
          isolated,
          reason,
          result.latencyMs,
          result.balance,
          result.balanceCurrency,
          result.balanceStatus,
        ],
      );
      await client.query(
        `INSERT INTO health_checks (channel_id, ok, latency_ms, models_ok, chat_ok, stream_ok, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [channelId, result.ok, result.latencyMs, result.models.length > 0, result.chatOk, result.streamOk, result.error],
      );
      await client.query(
        `INSERT INTO balance_snapshots (channel_id, balance, currency, status)
         VALUES ($1, $2, $3, $4)`,
        [channelId, result.balance, result.balanceCurrency, result.balanceStatus],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const updated = await this.getChannel(channelId);
    if (!updated) throw new Error("Channel not found after probe");
    return updated;
  }

  async recordUsage(event: UsageEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_events
       (request_id, channel_id, model_alias, upstream_model, client_name, request_kind, status_code,
       prompt_tokens, completion_tokens, latency_ms, error_type, retry_count, streamed,
        endpoint, source_ip, gateway_key_name, cached_tokens, cost_usd, first_byte_latency_ms, reasoning_effort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
        event.sourceIp ?? null,
        event.gatewayKeyName ?? null,
        event.cachedTokens ?? null,
        event.costUsd ?? null,
        event.firstByteLatencyMs ?? null,
        event.reasoningEffort ?? null,
      ],
    );
  }

  async listRequestLogs(filters: RequestLogFilters): Promise<RequestLogPage> {
    const interval = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days" }[filters.window];
    const params: unknown[] = [interval];
    const clauses = ["ue.created_at >= now() - $1::interval"];
    const addFilter = (value: string | undefined, expression: string) => {
      const normalized = value?.trim();
      if (!normalized) return;
      params.push(`%${normalized}%`);
      clauses.push(`${expression} ILIKE $${params.length}`);
    };
    addFilter(filters.client, "ue.client_name");
    addFilter(filters.channel, "coalesce(c.name, '') || ' ' || coalesce(p.name, '')");
    addFilter(filters.model, "ue.model_alias || ' ' || coalesce(ue.upstream_model, '')");
    addFilter(filters.sourceIp, "coalesce(ue.source_ip::text, '')");
    if (filters.localOnly) clauses.push("ue.source_ip::text IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')");
    const where = clauses.join(" AND ");
    const [countResult, clientOptions, channelOptions, modelOptions, sourceIpOptions] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total FROM usage_events ue LEFT JOIN channels c ON c.id = ue.channel_id LEFT JOIN providers p ON p.id = c.provider_id WHERE ${where}`, params),
      this.pool.query<{ value: string }>("SELECT DISTINCT client_name AS value FROM usage_events WHERE created_at >= now() - $1::interval AND client_name <> '' ORDER BY 1", [interval]),
      this.pool.query<{ value: string }>("SELECT DISTINCT coalesce(c.name, 'unrouted') AS value FROM usage_events ue LEFT JOIN channels c ON c.id = ue.channel_id WHERE ue.created_at >= now() - $1::interval ORDER BY 1", [interval]),
      this.pool.query<{ value: string }>("SELECT DISTINCT model_alias AS value FROM usage_events WHERE created_at >= now() - $1::interval AND model_alias <> '' ORDER BY 1", [interval]),
      this.pool.query<{ value: string }>("SELECT DISTINCT source_ip::text AS value FROM usage_events WHERE created_at >= now() - $1::interval AND source_ip IS NOT NULL ORDER BY 1", [interval]),
    ]);
    const total = Number(countResult.rows[0]?.total ?? 0);
    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const rows = await this.pool.query(
      `SELECT ue.id, ue.request_id, ue.created_at, ue.channel_id, c.name AS channel_name, p.name AS provider_name,
              pc.key_name, pc.key_last4,
              ue.model_alias, ue.upstream_model, ue.client_name, ue.source_ip, ue.gateway_key_name, ue.reasoning_effort, ue.request_kind, ue.endpoint,
              ue.status_code, ue.prompt_tokens, ue.completion_tokens, ue.cached_tokens, ue.cost_usd,
              ue.latency_ms, ue.first_byte_latency_ms, ue.error_type, ue.retry_count, ue.streamed
       FROM usage_events ue
       LEFT JOIN channels c ON c.id = ue.channel_id
       LEFT JOIN providers p ON p.id = c.provider_id
       LEFT JOIN provider_credentials pc ON pc.id = c.credential_id
       WHERE ${where}
       ORDER BY ue.created_at DESC, ue.id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, filters.limit, filters.offset],
    );
    return {
      items: rows.rows.map((row) => ({
        id: String(row.id),
        requestId: String(row.request_id),
        createdAt: new Date(row.created_at).toISOString(),
        channelId: row.channel_id === null ? null : String(row.channel_id),
        channelName: row.channel_name === null ? null : String(row.channel_name),
        providerName: row.provider_name === null ? null : String(row.provider_name),
        keyName: row.key_name === null ? "API Key" : String(row.key_name),
        gatewayKeyName: row.gateway_key_name === null ? null : String(row.gateway_key_name),
        reasoningEffort: row.reasoning_effort === null ? null : String(row.reasoning_effort),
        modelAlias: String(row.model_alias),
        upstreamModel: row.upstream_model === null ? null : String(row.upstream_model),
        clientName: String(row.client_name),
        sourceIp: row.source_ip === null ? null : String(row.source_ip),
        requestKind: row.request_kind,
        endpoint: row.endpoint ? String(row.endpoint) : endpointForKind(row.request_kind),
        statusCode: Number(row.status_code),
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
        cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        latencyMs: Number(row.latency_ms),
        firstByteLatencyMs: row.first_byte_latency_ms === null ? null : Number(row.first_byte_latency_ms),
        errorType: row.error_type === null ? null : String(row.error_type),
        retryCount: Number(row.retry_count),
        streamed: Boolean(row.streamed),
      })),
      total,
      limit: filters.limit,
      offset: filters.offset,
      hasMore: filters.offset + rows.rows.length < total,
      filterOptions: {
        clients: clientOptions.rows.map((row) => String(row.value)),
        channels: channelOptions.rows.map((row) => String(row.value)),
        models: modelOptions.rows.map((row) => String(row.value)),
        sourceIps: sourceIpOptions.rows.map((row) => String(row.value)),
      },
    };
  }

  async listPlaygroundSessions(limit = 30): Promise<PlaygroundSession[]> {
    const result = await this.pool.query(
      `SELECT * FROM playground_sessions ORDER BY updated_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map(mapPlaygroundSession);
  }

  async getPlaygroundSession(id: string): Promise<PlaygroundSession | null> {
    const result = await this.pool.query("SELECT * FROM playground_sessions WHERE id = $1", [id]);
    return result.rows[0] ? mapPlaygroundSession(result.rows[0]) : null;
  }

  async savePlaygroundSession(session: PlaygroundSession): Promise<PlaygroundSession> {
    const result = await this.pool.query(
      `INSERT INTO playground_sessions
        (id, channel_id, channel_name, provider_name, model, temperature, top_p, max_tokens,
         frequency_penalty, presence_penalty, stream, messages, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         channel_name = EXCLUDED.channel_name,
         provider_name = EXCLUDED.provider_name,
         model = EXCLUDED.model,
         temperature = EXCLUDED.temperature,
         top_p = EXCLUDED.top_p,
         max_tokens = EXCLUDED.max_tokens,
          frequency_penalty = EXCLUDED.frequency_penalty,
          presence_penalty = EXCLUDED.presence_penalty,
          stream = EXCLUDED.stream,
          messages = EXCLUDED.messages,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
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
    return mapPlaygroundSession(result.rows[0]!);
  }

  async deletePlaygroundSession(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM playground_sessions WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async recordChannelFailure(channelId: string, reason: string, failureThreshold: number): Promise<void> {
    await this.pool.query(
      `UPDATE channels SET
         consecutive_failures = consecutive_failures + 1,
         status = CASE WHEN consecutive_failures + 1 >= $3 THEN 'isolated' ELSE 'degraded' END,
         cooldown_until = CASE WHEN consecutive_failures + 1 >= $3 THEN now() + interval '5 minutes' ELSE cooldown_until END,
         isolation_reason = $2,
         updated_at = now()
       WHERE id = $1`,
      [channelId, reason, failureThreshold],
    );
  }

  async recordChannelSuccess(channelId: string, latencyMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE channels SET status = 'healthy', consecutive_failures = 0, cooldown_until = NULL,
         isolation_reason = NULL, last_latency_ms = $2, updated_at = now()
       WHERE id = $1 AND enabled = true`,
      [channelId, latencyMs],
    );
  }

  async getPools(): Promise<PoolSummary[]> {
    const routes = await this.pool.query(
      `SELECT ma.alias, ma.upstream_model, c.id AS channel_id, c.name AS channel_name,
              p.name AS provider_name, c.status, c.priority, c.weight
       FROM model_aliases ma
       JOIN channels c ON c.id = ma.channel_id
       JOIN providers p ON p.id = c.provider_id
       WHERE ma.enabled = true
       ORDER BY ma.alias, c.priority DESC, c.weight DESC`,
    );
    const metrics = await this.pool.query(
      `SELECT model_alias, count(*)::int AS requests,
               count(*) FILTER (WHERE status_code >= 400)::int AS errors,
               coalesce(avg(latency_ms), 0)::float AS latency,
               count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS requests_24h,
               count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status_code < 400)::int AS successful_requests_24h,
               count(*) FILTER (WHERE created_at >= now() - interval '15 minutes')::int AS requests_15m,
               coalesce(avg(latency_ms) FILTER (WHERE created_at >= now() - interval '15 minutes'), 0)::float AS latency_15m,
               coalesce(max(latency_ms) FILTER (WHERE created_at >= now() - interval '15 minutes'), 0)::float AS peak_latency_15m
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= now() - interval '24 hours'
       GROUP BY model_alias`,
    );
    const latestRequests = await this.pool.query(
      `SELECT model_alias, max(created_at) AS last_requested_at
       FROM usage_events
       GROUP BY model_alias`,
    );
    const metricMap = new Map(metrics.rows.map((row) => [String(row.model_alias), row]));
    const latestRequestByAlias = new Map<string, number>();
    for (const row of latestRequests.rows) {
      const value = row.last_requested_at;
      const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
      if (Number.isFinite(timestamp)) latestRequestByAlias.set(String(row.model_alias), timestamp);
    }
    const hourly = await this.pool.query(
      `SELECT model_alias, date_trunc('hour', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('hour', now()) - interval '23 hours'
       GROUP BY model_alias, date_trunc('hour', created_at)`,
    );
    const routeHourly = await this.pool.query(
      `SELECT model_alias, channel_id, date_trunc('hour', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('hour', now()) - interval '23 hours'
       GROUP BY model_alias, channel_id, date_trunc('hour', created_at)`,
    );
    const recent = await this.pool.query(
      `SELECT model_alias,
              to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= now() - interval '6 hours'
       GROUP BY model_alias, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300)`,
    );
    const routeRecent = await this.pool.query(
      `SELECT model_alias, channel_id,
              to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= now() - interval '6 hours'
       GROUP BY model_alias, channel_id, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300)`,
    );
    const health1h = await this.pool.query(
      `SELECT model_alias,
              to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= now() - interval '1 hour'
       GROUP BY model_alias, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300)` ,
    );
    const routeHealth1h = await this.pool.query(
      `SELECT model_alias, channel_id,
              to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= now() - interval '1 hour'
       GROUP BY model_alias, channel_id, to_timestamp(floor(extract(epoch FROM created_at) / 300) * 300)` ,
    );
    const health12h = await this.pool.query(
      `SELECT model_alias, date_trunc('hour', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('hour', now()) - interval '11 hours'
       GROUP BY model_alias, date_trunc('hour', created_at)` ,
    );
    const routeHealth12h = await this.pool.query(
      `SELECT model_alias, channel_id, date_trunc('hour', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('hour', now()) - interval '11 hours'
       GROUP BY model_alias, channel_id, date_trunc('hour', created_at)` ,
    );
    const health7d = await this.pool.query(
      `SELECT model_alias, date_trunc('day', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('day', now()) - interval '6 days'
       GROUP BY model_alias, date_trunc('day', created_at)` ,
    );
    const routeHealth7d = await this.pool.query(
      `SELECT model_alias, channel_id, date_trunc('day', created_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status_code < 400)::int AS successful_requests,
              coalesce(avg(latency_ms), 0)::float AS latency,
              coalesce(max(latency_ms), 0)::float AS peak_latency
       FROM usage_events
       WHERE error_type IS DISTINCT FROM 'client_closed_request'
         AND created_at >= date_trunc('day', now()) - interval '6 days'
       GROUP BY model_alias, channel_id, date_trunc('day', created_at)` ,
    );
    const hourlyMap = new Map<string, typeof hourly.rows>();
    for (const row of hourly.rows) {
      const alias = String(row.model_alias);
      const rows = hourlyMap.get(alias) ?? [];
      rows.push(row);
      hourlyMap.set(alias, rows);
    }
    const routeHourlyMap = new Map<string, typeof routeHourly.rows>();
    for (const row of routeHourly.rows) {
      const key = `${String(row.model_alias)}:${String(row.channel_id)}`;
      const rows = routeHourlyMap.get(key) ?? [];
      rows.push(row);
      routeHourlyMap.set(key, rows);
    }
    const recentMap = new Map<string, typeof recent.rows>();
    for (const row of recent.rows) {
      const alias = String(row.model_alias);
      const rows = recentMap.get(alias) ?? [];
      rows.push(row);
      recentMap.set(alias, rows);
    }
    const routeRecentMap = new Map<string, typeof routeRecent.rows>();
    for (const row of routeRecent.rows) {
      const key = `${String(row.model_alias)}:${String(row.channel_id)}`;
      const rows = routeRecentMap.get(key) ?? [];
      rows.push(row);
      routeRecentMap.set(key, rows);
    }
    const health1hMap = new Map<string, typeof health1h.rows>();
    for (const row of health1h.rows) {
      const alias = String(row.model_alias);
      health1hMap.set(alias, [...(health1hMap.get(alias) ?? []), row]);
    }
    const routeHealth1hMap = new Map<string, typeof routeHealth1h.rows>();
    for (const row of routeHealth1h.rows) {
      const key = `${String(row.model_alias)}:${String(row.channel_id)}`;
      routeHealth1hMap.set(key, [...(routeHealth1hMap.get(key) ?? []), row]);
    }
    const health12hMap = new Map<string, typeof health12h.rows>();
    for (const row of health12h.rows) {
      const alias = String(row.model_alias);
      health12hMap.set(alias, [...(health12hMap.get(alias) ?? []), row]);
    }
    const routeHealth12hMap = new Map<string, typeof routeHealth12h.rows>();
    for (const row of routeHealth12h.rows) {
      const key = `${String(row.model_alias)}:${String(row.channel_id)}`;
      routeHealth12hMap.set(key, [...(routeHealth12hMap.get(key) ?? []), row]);
    }
    const health7dMap = new Map<string, typeof health7d.rows>();
    for (const row of health7d.rows) {
      const alias = String(row.model_alias);
      health7dMap.set(alias, [...(health7dMap.get(alias) ?? []), row]);
    }
    const routeHealth7dMap = new Map<string, typeof routeHealth7d.rows>();
    for (const row of routeHealth7d.rows) {
      const key = `${String(row.model_alias)}:${String(row.channel_id)}`;
      routeHealth7dMap.set(key, [...(routeHealth7dMap.get(key) ?? []), row]);
    }
    const pools = new Map<string, PoolSummary>();
    for (const row of routes.rows) {
      const alias = String(row.alias);
      const metric = metricMap.get(alias);
      const hourlyHealth = buildHourlyHealth(hourlyMap.get(alias) ?? []);
      const health1hPoints = buildRecentHealth(health1hMap.get(alias) ?? [], 60 * 60 * 1000);
      const recentHealth = buildRecentHealth(recentMap.get(alias) ?? []);
      const health12hPoints = buildHourlyHealth(health12hMap.get(alias) ?? [], 12);
      const health7dPoints = buildDailyHealth(health7dMap.get(alias) ?? []);
      const pool = pools.get(alias) ?? {
        alias,
        channels: 0,
        healthyChannels: 0,
        totalRequests1h: Number(metric?.requests ?? 0),
        errorRate1h: Number(metric?.requests ?? 0) > 0 ? Number(metric?.errors ?? 0) / Number(metric?.requests) : 0,
        averageLatencyMs1h: Math.round(Number(metric?.latency ?? 0)),
        requests24h: Number(metric?.requests_24h ?? 0),
        successfulRequests24h: Number(metric?.successful_requests_24h ?? 0),
         successRate24h: Number(metric?.requests_24h ?? 0) ? Number(metric?.successful_requests_24h ?? 0) / Number(metric?.requests_24h) : null,
         requests6h: recentHealth.reduce((sum, point) => sum + point.requests, 0),
         successfulRequests6h: recentHealth.reduce((sum, point) => sum + point.successfulRequests, 0),
         successRate6h: recentSuccessRate(recentHealth),
        requests15m: Number(metric?.requests_15m ?? 0),
        averageLatencyMs15m: Math.round(Number(metric?.latency_15m ?? 0)),
        peakLatencyMs15m: Math.round(Number(metric?.peak_latency_15m ?? 0)),
        health1h: health1hPoints,
        hourlyHealth,
        recentHealth,
        health12h: health12hPoints,
        health7d: health7dPoints,
        routes: [],
      };
      pool.channels += 1;
      if (row.status === "healthy") pool.healthyChannels += 1;
      pool.routes.push({
        channelId: String(row.channel_id),
        channelName: String(row.channel_name),
        providerName: String(row.provider_name),
        upstreamModel: String(row.upstream_model),
        status: row.status,
        priority: Number(row.priority),
         weight: Number(row.weight),
         health1h: buildRecentHealth(routeHealth1hMap.get(`${alias}:${String(row.channel_id)}`) ?? [], 60 * 60 * 1000),
         hourlyHealth: buildRouteHourlyHealth(routeHourlyMap.get(`${alias}:${String(row.channel_id)}`) ?? []),
         recentHealth: buildRouteRecentHealth(routeRecentMap.get(`${alias}:${String(row.channel_id)}`) ?? []),
         health12h: buildHourlyHealth(routeHealth12hMap.get(`${alias}:${String(row.channel_id)}`) ?? [], 12),
         health7d: buildDailyHealth(routeHealth7dMap.get(`${alias}:${String(row.channel_id)}`) ?? []),
      });
      pools.set(alias, pool);
    }
    return [...pools.values()].sort((a, b) => {
      const latestDifference = (latestRequestByAlias.get(b.alias) ?? 0) - (latestRequestByAlias.get(a.alias) ?? 0);
      return latestDifference || a.alias.localeCompare(b.alias, "zh-CN");
    });
  }

  async getUsage(window: "1h" | "24h" | "7d"): Promise<UsageSummary> {
    const interval = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days" }[window];
    const bucket = window === "1h" ? "minute" : window === "24h" ? "hour" : "day";
    const [total, byClient, byError, byModel, byChannel, timeline] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS requests,
                count(*) FILTER (WHERE status_code < 400)::int AS successes,
                coalesce(avg(latency_ms), 0)::float AS latency,
                coalesce(sum(prompt_tokens), 0)::int AS prompt_tokens,
                coalesce(sum(completion_tokens), 0)::int AS completion_tokens
         FROM usage_events WHERE created_at >= now() - $1::interval`,
        [interval],
      ),
      this.pool.query(
        `SELECT client_name AS name, count(*)::int AS requests,
                count(*) FILTER (WHERE status_code >= 400)::int AS errors,
                coalesce(avg(latency_ms), 0)::float AS latency
         FROM usage_events WHERE created_at >= now() - $1::interval
         GROUP BY client_name ORDER BY requests DESC LIMIT 20`,
        [interval],
      ),
      this.pool.query(
        `SELECT error_type AS name, count(*)::int AS requests, count(*)::int AS errors,
                coalesce(avg(latency_ms), 0)::float AS latency
         FROM usage_events WHERE created_at >= now() - $1::interval AND error_type IS NOT NULL
         GROUP BY error_type ORDER BY requests DESC LIMIT 20`,
        [interval],
      ),
      this.pool.query(
        `SELECT model_alias AS name, count(*)::int AS requests,
                count(*) FILTER (WHERE status_code >= 400)::int AS errors,
                coalesce(avg(latency_ms), 0)::float AS latency
         FROM usage_events WHERE created_at >= now() - $1::interval
         GROUP BY model_alias ORDER BY requests DESC LIMIT 20`,
        [interval],
      ),
      this.pool.query(
        `SELECT coalesce(c.name, 'unrouted') AS name, count(*)::int AS requests,
                count(*) FILTER (WHERE ue.status_code >= 400)::int AS errors,
                coalesce(avg(ue.latency_ms), 0)::float AS latency
         FROM usage_events ue LEFT JOIN channels c ON c.id = ue.channel_id
         WHERE ue.created_at >= now() - $1::interval
         GROUP BY c.name ORDER BY requests DESC LIMIT 20`,
        [interval],
      ),
      this.pool.query(
        `SELECT date_trunc($2, created_at) AS bucket, count(*)::int AS requests,
                count(*) FILTER (WHERE status_code >= 400)::int AS errors
         FROM usage_events WHERE created_at >= now() - $1::interval
         GROUP BY 1 ORDER BY 1`,
        [interval, bucket],
      ),
    ]);
    const row = total.rows[0]!;
    const requests = Number(row.requests);
    return {
      window,
      totalRequests: requests,
      successfulRequests: Number(row.successes),
      errorRate: requests > 0 ? (requests - Number(row.successes)) / requests : 0,
      averageLatencyMs: Math.round(Number(row.latency)),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      byModel: mapUsageGroups(byModel.rows),
      byChannel: mapUsageGroups(byChannel.rows),
      byClient: mapUsageGroups(byClient.rows),
      byError: mapUsageGroups(byError.rows),
      timeline: timeline.rows.map((item) => ({
        bucket: new Date(item.bucket).toISOString(),
        requests: Number(item.requests),
        errors: Number(item.errors),
      })),
    };
  }

  async getBalances(): Promise<Channel[]> {
    return this.listChannels();
  }

  async listHealthCheckChannels(): Promise<Channel[]> {
    const result = await this.pool.query(
      channelSelect("c.enabled = true AND (c.cooldown_until IS NULL OR c.cooldown_until <= now())") +
        " ORDER BY c.last_checked_at ASC NULLS FIRST",
    );
    return result.rows.map(mapChannel);
  }

  async listGatewayKeys(): Promise<GatewayKeySummary[]> {
    const result = await this.pool.query(
      `SELECT id, name, key_last4, enabled, created_at, last_used_at
       FROM gateway_keys ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      keyLast4: String(row.key_last4),
      enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    }));
  }

  async createGatewayKey(name: string, keyHash: string, keyLast4: string): Promise<GatewayKey> {
    const result = await this.pool.query(
      `INSERT INTO gateway_keys (name, key_hash, key_last4)
       VALUES ($1, $2, $3)
       RETURNING id, name, key_hash, key_last4, enabled, created_at, last_used_at`,
      [name, keyHash, keyLast4],
    );
    return mapGatewayKey(result.rows[0]!);
  }

  async deleteGatewayKey(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM gateway_keys WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async hasGatewayKey(keyHash: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM gateway_keys WHERE key_hash = $1 AND enabled = true LIMIT 1",
      [keyHash],
    );
    return result.rowCount === 1;
  }

  async findGatewayKey(keyHash: string): Promise<GatewayKeySummary | null> {
    const result = await this.pool.query(
      `UPDATE gateway_keys
       SET last_used_at = now()
       WHERE key_hash = $1 AND enabled = true
       RETURNING id, name, key_last4, enabled, created_at, last_used_at`,
      [keyHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      keyLast4: String(row.key_last4),
      enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    };
  }

  async getAdminAccount(): Promise<AdminAccount | null> {
    const result = await this.pool.query("SELECT username, password_hash, created_at, updated_at FROM admin_accounts WHERE id = 1");
    const row = result.rows[0];
    return row ? {
      username: String(row.username),
      passwordHash: String(row.password_hash),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    } : null;
  }

  async saveAdminAccount(account: AdminAccount): Promise<AdminAccount> {
    await this.pool.query(
      `INSERT INTO admin_accounts (id, username, password_hash, created_at, updated_at)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at`,
      [account.username, account.passwordHash, account.createdAt, account.updatedAt],
    );
    return account;
  }

  async recordAdminLogin(record: Omit<AdminLoginRecord, "id">): Promise<AdminLoginRecord> {
    const result = await this.pool.query(
      `INSERT INTO admin_login_history (username, ip, user_agent, success, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, ip, user_agent, success, reason, created_at`,
      [record.username, record.ip, record.userAgent, record.success, record.reason, record.createdAt],
    );
    await this.pool.query(`DELETE FROM admin_login_history WHERE id NOT IN (SELECT id FROM admin_login_history ORDER BY created_at DESC, id DESC LIMIT 10)`);
    return mapAdminLoginRecord(result.rows[0]!);
  }

  async listAdminLoginHistory(limit = 10): Promise<AdminLoginRecord[]> {
    const result = await this.pool.query(
      `SELECT id, username, ip, user_agent, success, reason, created_at
       FROM admin_login_history ORDER BY created_at DESC, id DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 10))],
    );
    return result.rows.map(mapAdminLoginRecord);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async upsertModelAlias(db: Db, input: ModelAliasInput): Promise<void> {
    await db.query(
      `INSERT INTO model_aliases (alias, channel_id, upstream_model, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (alias, channel_id, upstream_model) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [input.alias, input.channelId, input.upstreamModel, input.enabled ?? true],
    );
  }
}

function channelSelect(where: string, includeAlias = false): string {
  return `SELECT c.*, p.name AS provider_name, pc.key_ciphertext, pc.key_name, pc.key_last4,
                 coalesce(stats.requests, 0)::int AS recent_request_count,
                 coalesce(stats.error_rate, 0)::float AS recent_error_rate
                 ${includeAlias ? ", ma.upstream_model" : ""}
          FROM channels c
          JOIN providers p ON p.id = c.provider_id
          JOIN provider_credentials pc ON pc.id = c.credential_id
          ${includeAlias ? "JOIN model_aliases ma ON ma.channel_id = c.id" : ""}
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS requests,
                   CASE WHEN count(*) = 0 THEN 0
                        ELSE count(*) FILTER (WHERE status_code >= 400)::float / count(*) END AS error_rate
            FROM usage_events ue
            WHERE ue.channel_id = c.id
              AND ue.error_type IS DISTINCT FROM 'client_closed_request'
              AND ue.created_at >= now() - interval '15 minutes'
          ) stats ON true
          WHERE ${where}`;
}

function buildHourlyHealth(rows: QueryResultRow[], hours = 24) {
  const hourlyHealth = createHourlyHealth(Date.now(), hours);
  for (const row of rows) {
    const point = hourlyHealth.find((item) => item.bucket === new Date(row.bucket).toISOString());
    if (!point) continue;
    point.requests = Number(row.requests);
    point.successfulRequests = Number(row.successful_requests);
    point.averageLatencyMs = Number(row.latency);
    point.peakLatencyMs = Number(row.peak_latency);
    finalizeHealthPoint(point);
  }
  return hourlyHealth;
}

function buildRecentHealth(rows: QueryResultRow[], windowMs = 6 * 60 * 60 * 1000) {
  const recentHealth = createRecentHealth(Date.now(), windowMs);
  for (const row of rows) {
    const point = recentHealth.find((item) => item.bucket === new Date(row.bucket).toISOString());
    if (!point) continue;
    point.requests = Number(row.requests);
    point.successfulRequests = Number(row.successful_requests);
    point.averageLatencyMs = Number(row.latency);
    point.peakLatencyMs = Number(row.peak_latency);
    finalizeHealthPoint(point);
  }
  return recentHealth;
}

function buildDailyHealth(rows: QueryResultRow[]) {
  const dailyHealth = createDailyHealth();
  for (const row of rows) {
    const point = dailyHealth.find((item) => item.bucket === new Date(row.bucket).toISOString());
    if (!point) continue;
    point.requests = Number(row.requests);
    point.successfulRequests = Number(row.successful_requests);
    point.averageLatencyMs = Number(row.latency);
    point.peakLatencyMs = Number(row.peak_latency);
    finalizeHealthPoint(point);
  }
  return dailyHealth;
}

function buildRouteHourlyHealth(rows: QueryResultRow[]) {
  return buildHourlyHealth(rows);
}

function buildRouteRecentHealth(rows: QueryResultRow[]) {
  return buildRecentHealth(rows);
}

function recentSuccessRate(points: Array<{ requests: number; successfulRequests: number }>) {
  const requests = points.reduce((sum, point) => sum + point.requests, 0);
  const successes = points.reduce((sum, point) => sum + point.successfulRequests, 0);
  return requests ? successes / requests : null;
}

function mapChannel(row: QueryResultRow): Channel {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    providerName: String(row.provider_name),
    name: String(row.name),
    baseUrl: String(row.base_url),
    faviconUrl: row.favicon_url === null || row.favicon_url === undefined ? null : String(row.favicon_url),
    protocol: row.protocol,
    keyCiphertext: String(row.key_ciphertext),
    keyName: row.key_name ? String(row.key_name) : "API Key",
    keyLast4: String(row.key_last4),
    status: row.status,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    weight: Number(row.weight),
    minBalance: row.min_balance === null ? null : Number(row.min_balance),
    balance: row.current_balance === null ? null : Number(row.current_balance),
    balanceCurrency: row.balance_currency === null ? null : String(row.balance_currency),
    balanceStatus: row.balance_status,
    consecutiveFailures: Number(row.consecutive_failures),
    cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
    isolationReason: row.isolation_reason === null ? null : String(row.isolation_reason),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    lastLatencyMs: row.last_latency_ms === null ? null : Number(row.last_latency_ms),
    recentRequestCount: Number(row.recent_request_count ?? 0),
    recentErrorRate: Number(row.recent_error_rate ?? 0),
    models: Array.isArray(row.available_models) ? row.available_models : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapGatewayKey(row: QueryResultRow): GatewayKey {
  return {
    id: String(row.id),
    name: String(row.name),
    keyHash: String(row.key_hash),
    keyLast4: String(row.key_last4),
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

function mapAdminLoginRecord(row: QueryResultRow): AdminLoginRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    ip: String(row.ip),
    userAgent: String(row.user_agent),
    success: Boolean(row.success),
    reason: row.reason === null ? null : String(row.reason),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapUsageGroups(rows: QueryResultRow[]) {
  return rows.map((row) => ({
    name: String(row.name),
    requests: Number(row.requests),
    errors: Number(row.errors),
    latencyMs: Math.round(Number(row.latency)),
  }));
}

function mapPlaygroundSession(row: QueryResultRow): PlaygroundSession {
  return {
    id: String(row.id),
    channelId: row.channel_id === null ? null : String(row.channel_id),
    channelName: String(row.channel_name),
    providerName: String(row.provider_name),
    model: String(row.model),
    temperature: row.temperature === null ? null : Number(row.temperature),
    topP: row.top_p === null ? null : Number(row.top_p),
    maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
    frequencyPenalty: row.frequency_penalty === null ? null : Number(row.frequency_penalty),
    presencePenalty: row.presence_penalty === null ? null : Number(row.presence_penalty),
    stream: row.stream === null || row.stream === undefined ? true : Boolean(row.stream),
    messages: Array.isArray(row.messages) ? row.messages : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function getBalanceStatus(balance: number | null, minBalance: number | null): Channel["balanceStatus"] {
  if (balance === null) return "unknown";
  if (balance <= 0) return "exhausted";
  if (minBalance !== null && balance < minBalance) return "low";
  return "ok";
}

function endpointForKind(kind: string): string {
  return kind === "responses" ? "/responses" : kind === "messages" ? "/messages" : "/chat/completions";
}
