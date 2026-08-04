import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OpsAgent } from "../agent/ops-agent.js";
import type { GatewayStore } from "../domain/store.js";
import type { GatewayRequest, PlaygroundSession, PlaygroundSessionMessage } from "../domain/types.js";
import type { GatewayRouter } from "../gateway/router.js";
import { GatewayError } from "../gateway/errors.js";
import { generateGatewayKey, hashGatewayKey } from "../security/gateway-key.js";
import { AdminAuthService } from "../security/admin-auth.js";

const importSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channelName: z.string().trim().min(1).max(120).optional(),
  website: z.string().url().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().trim().min(6),
  protocol: z.enum(["auto", "openai", "claude", "gemini", "new-api", "sub2api"]).default("auto"),
  models: z.array(z.string().trim().min(1)).max(500).default([]),
  priority: z.number().int().min(-100).max(100).default(0),
  weight: z.number().int().min(1).max(10_000).default(100),
  minBalance: z.number().min(0).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const aliasSchema = z.object({
  alias: z.string().trim().min(1),
  channelId: z.string().uuid(),
  upstreamModel: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});

const modelProbeSchema = importSchema.pick({ baseUrl: true, apiKey: true, protocol: true, models: true });

const channelModelProbeSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().trim().min(6).optional().or(z.literal("")),
  protocol: z.enum(["auto", "openai", "claude", "gemini", "new-api", "sub2api"]).optional(),
});

const channelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  apiKey: z.string().trim().min(6).optional().or(z.literal("")),
  protocol: z.enum(["auto", "openai", "claude", "gemini", "new-api", "sub2api"]),
  models: z.array(z.string().trim().min(1)).max(500),
  priority: z.number().int().min(-100).max(100),
  weight: z.number().int().min(1).max(10_000),
  minBalance: z.number().min(0).nullable(),
  balance: z.number().min(0).nullable().optional(),
  balanceCurrency: z.string().trim().max(12).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  enabled: z.boolean().default(true),
});

const gatewayKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  key: z.string().trim().min(8).max(300).optional(),
});

const playgroundMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1).max(50_000),
  model: z.string().trim().min(1).max(200).optional(),
  channelId: z.string().uuid().optional(),
  channelName: z.string().trim().min(1).max(120).optional(),
  providerName: z.string().trim().min(1).max(120).optional(),
});

const playgroundSchema = z.object({
  sessionId: z.string().uuid().optional(),
  channelId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  messages: z.array(playgroundMessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  // Keep direct API callers backward-compatible; the web playground explicitly sends true by default.
  stream: z.boolean().default(false),
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(300),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(300),
  newPassword: z.string().min(8).max(300),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: { store: GatewayStore; agent: OpsAgent; router: GatewayRouter; adminAuth: AdminAuthService; gatewayBaseUrl: string },
) {
  app.post("/admin/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await dependencies.adminAuth.login(input.username, input.password, request);
    if (!result) return reply.code(401).send({ error: { message: "用户名或密码错误", type: "authentication_error" } });
    return result;
  });

  app.get("/admin/auth/me", async (request, reply) => {
    if (!dependencies.adminAuth.isValidToken(readAdminToken(request))) {
      return reply.code(401).send({ error: { message: "登录已失效，请重新登录", type: "authentication_error" } });
    }
    const account = await dependencies.store.getAdminAccount();
    return account ? { username: account.username } : reply.code(404).send({ error: { message: "管理员账号不存在", type: "not_found" } });
  });

  await app.register(async (admin) => {
    admin.addHook("onRequest", async (request, reply) => {
      if (!dependencies.adminAuth.isValidToken(readAdminToken(request))) {
        return reply.code(401).send({ error: { message: "登录已失效，请重新登录", type: "authentication_error" } });
      }
    });

    admin.get("/security/login-history", async () => dependencies.store.listAdminLoginHistory(10));

    admin.post("/security/password", async (request, reply) => {
      const input = passwordChangeSchema.parse(request.body);
      const changed = await dependencies.adminAuth.changePassword(input.currentPassword, input.newPassword);
      if (!changed) return reply.code(400).send({ error: { message: "当前密码错误", type: "validation_error" } });
      return { ok: true };
    });

    admin.get("/status", async () => {
      const [channels, pools, usage] = await Promise.all([
        dependencies.store.listChannels(),
        dependencies.store.getPools(),
        dependencies.store.getUsage("24h"),
      ]);
      return {
        status: "ok",
        channels: channels.length,
        healthyChannels: channels.filter((channel) => channel.status === "healthy").length,
        isolatedChannels: channels.filter((channel) => channel.status === "isolated").length,
        modelPools: pools.length,
        requests24h: usage.totalRequests,
        errorRate24h: usage.errorRate,
        averageLatencyMs24h: usage.averageLatencyMs,
        gatewayBaseUrl: dependencies.gatewayBaseUrl,
      };
    });

    admin.get("/gateway-keys", async () => dependencies.store.listGatewayKeys());

    admin.get<{ Querystring: { limit?: string } }>("/playground/sessions", async (request) => {
      const limit = Number.parseInt(request.query.limit ?? "30", 10);
      return dependencies.store.listPlaygroundSessions(Number.isFinite(limit) ? limit : 30);
    });

    admin.get<{ Params: { id: string } }>("/playground/sessions/:id", async (request) => {
      const session = await dependencies.store.getPlaygroundSession(request.params.id);
      if (!session) throw new GatewayError("测试记录不存在", 404, "not_found");
      return session;
    });

    admin.delete<{ Params: { id: string } }>("/playground/sessions/:id", async (request, reply) => {
      const deleted = await dependencies.store.deletePlaygroundSession(request.params.id);
      if (!deleted) return reply.code(404).send({ error: { message: "测试记录不存在", type: "not_found" } });
      return reply.code(204).send();
    });

    admin.post("/playground/chat", async (request) => {
      const input = playgroundSchema.parse(request.body);
      const channel = await dependencies.store.getChannel(input.channelId);
      if (!channel) throw new GatewayError("Channel not found", 404, "not_found");
      const now = new Date().toISOString();
      const existing = input.sessionId ? await dependencies.store.getPlaygroundSession(input.sessionId) : null;
      const session: PlaygroundSession = {
        id: input.sessionId ?? randomUUID(),
        channelId: channel.id,
        channelName: channel.name,
        providerName: channel.providerName,
        model: input.model,
        temperature: input.temperature ?? null,
        topP: input.topP ?? null,
        maxTokens: input.maxTokens ?? 1024,
        frequencyPenalty: input.frequencyPenalty ?? null,
        presencePenalty: input.presencePenalty ?? null,
        stream: input.stream,
        messages: input.messages.map(toPlaygroundSessionMessage),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await dependencies.store.savePlaygroundSession(session);
      const kind: GatewayRequest["kind"] = channel.protocol === "claude" ? "messages" : "chat";
      const upstreamMessages = input.messages.map(({ role, content }) => ({ role, content }));
      const gatewayRequest: GatewayRequest = {
        requestId: randomUUID(),
        kind,
        model: input.model,
        stream: input.stream,
        clientName: "model-playground",
        body: {
          model: input.model,
          messages: upstreamMessages,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.topP === undefined ? {} : { top_p: input.topP }),
          max_tokens: input.maxTokens ?? 1024,
          ...(input.frequencyPenalty === undefined ? {} : { frequency_penalty: input.frequencyPenalty }),
          ...(input.presencePenalty === undefined ? {} : { presence_penalty: input.presencePenalty }),
        },
      };
      try {
        const execution = await dependencies.router.executeDirect(gatewayRequest, input.channelId, input.model);
        const payload = await readExecutionBody(execution.result.body);
        const message = extractAssistantText(payload);
        if (!message) throw new GatewayError("Upstream response did not contain assistant text", 502, "invalid_upstream_response");
        await dependencies.store.savePlaygroundSession({
          ...session,
          messages: [...session.messages, {
            role: "assistant",
            content: message,
            model: execution.upstreamModel,
            channelId: execution.channelId,
            channelName: channel.name,
            providerName: channel.providerName,
            latencyMs: execution.latencyMs,
            promptTokens: execution.promptTokens,
            completionTokens: execution.completionTokens,
            totalTokens: execution.promptTokens + execution.completionTokens,
            createdAt: new Date().toISOString(),
          }],
          updatedAt: new Date().toISOString(),
        });
        return {
          sessionId: session.id,
          message,
          model: execution.upstreamModel,
          channelId: execution.channelId,
          channelName: channel.name,
          providerName: channel.providerName,
          latencyMs: execution.latencyMs,
          usage: {
            promptTokens: execution.promptTokens,
            completionTokens: execution.completionTokens,
            totalTokens: execution.promptTokens + execution.completionTokens,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "测试请求失败";
        const errorType = error instanceof GatewayError ? error.errorType : "internal_error";
        await dependencies.store.savePlaygroundSession({
          ...session,
          messages: [...session.messages, {
            role: "assistant",
            content: errorMessage,
            model: input.model,
            channelId: channel.id,
            channelName: channel.name,
            providerName: channel.providerName,
            errorType,
            createdAt: new Date().toISOString(),
          }],
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
    });

    admin.post("/gateway-keys", async (request, reply) => {
      const input = gatewayKeySchema.parse(request.body);
      const key = input.key ?? generateGatewayKey();
      const keyHash = hashGatewayKey(key);
      if (await dependencies.store.hasGatewayKey(keyHash)) {
        return reply.code(409).send({ error: { message: "Gateway key already exists", type: "conflict" } });
      }
      const created = await dependencies.store.createGatewayKey(input.name, keyHash, key.slice(-4));
      return reply.code(201).send({ key, gatewayKey: sanitizeGatewayKey(created) });
    });

    admin.delete<{ Params: { id: string } }>("/gateway-keys/:id", async (request, reply) => {
      const keys = await dependencies.store.listGatewayKeys();
      if (keys.length <= 1) {
        return reply.code(409).send({ error: { message: "At least one gateway key must remain", type: "conflict" } });
      }
      const deleted = await dependencies.store.deleteGatewayKey(request.params.id);
      if (!deleted) return reply.code(404).send({ error: { message: "Gateway key not found", type: "not_found" } });
      return reply.code(204).send();
    });

    admin.post("/providers/import", async (request, reply) => {
      const input = importSchema.parse(request.body);
      const imported = await dependencies.agent.onboard(input);
      return reply.code(201).send({
        providerId: imported.providerId,
        channel: sanitizeChannel(imported.channel),
      });
    });

    admin.post("/providers/models", async (request) => {
      const input = modelProbeSchema.parse(request.body);
      return dependencies.agent.discoverModels(input);
    });

    admin.post<{ Params: { id: string } }>("/channels/:id/models", async (request) => {
      const input = channelModelProbeSchema.parse(request.body);
      return dependencies.agent.discoverChannelModels(request.params.id, input);
    });

    admin.get("/channels", async () => (await dependencies.store.listChannels()).map(sanitizeChannel));

    admin.put<{ Params: { id: string } }>("/channels/:id", async (request) => {
      const input = channelUpdateSchema.parse(request.body);
      const channel = await dependencies.agent.updateChannel(request.params.id, input);
      return { channel: sanitizeChannel(channel) };
    });

    admin.delete<{ Params: { id: string } }>("/channels/:id", async (request, reply) => {
      const deleted = await dependencies.store.deleteChannel(request.params.id);
      if (!deleted) return reply.code(404).send({ error: { message: "Channel not found", type: "not_found" } });
      return reply.code(204).send();
    });

    admin.patch<{ Params: { id: string } }>("/channels/:id/enabled", async (request) => {
      const body = z.object({ enabled: z.boolean() }).parse(request.body);
      const channel = await dependencies.store.setChannelEnabled(request.params.id, body.enabled);
      if (!channel) throw new Error("Channel not found");
      return { channel: sanitizeChannel(channel) };
    });

    admin.post<{ Params: { id: string } }>("/channels/:id/probe", async (request) => {
      const probe = await dependencies.agent.probeChannel(request.params.id);
      const channel = await dependencies.store.getChannel(request.params.id);
      return { channel: channel ? sanitizeChannel(channel) : null, probe };
    });

    admin.post("/model-aliases", async (request, reply) => {
      const input = aliasSchema.parse(request.body);
      await dependencies.store.saveModelAlias(input);
      return reply.code(201).send({ ok: true });
    });

    admin.get("/pools", () => dependencies.store.getPools());
    admin.get<{ Querystring: { window?: string } }>("/usage", (request) => {
      const window = z.enum(["1h", "24h", "7d"]).catch("24h").parse(request.query.window);
      return dependencies.store.getUsage(window);
    });
    admin.get<{ Querystring: { limit?: string; offset?: string; window?: string; client?: string; channel?: string; model?: string; sourceIp?: string; localOnly?: string } }>("/requests", (request) => {
      const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "20", 10) || 20));
      const offset = Math.max(0, Number.parseInt(request.query.offset ?? "0", 10) || 0);
      const window = z.enum(["1h", "24h", "7d"]).catch("24h").parse(request.query.window);
      const filters = {
        limit,
        offset,
        window,
        localOnly: request.query.localOnly === "true",
        ...(request.query.client?.trim() ? { client: request.query.client.trim() } : {}),
        ...(request.query.channel?.trim() ? { channel: request.query.channel.trim() } : {}),
        ...(request.query.model?.trim() ? { model: request.query.model.trim() } : {}),
        ...(request.query.sourceIp?.trim() ? { sourceIp: request.query.sourceIp.trim() } : {}),
      };
      return dependencies.store.listRequestLogs(filters);
    });
    admin.get("/balances", async () => (await dependencies.store.getBalances()).map(sanitizeChannel));
  }, { prefix: "/admin" });
}

function readAdminToken(request: { headers: Record<string, string | string[] | undefined> }): string {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  const legacy = request.headers["x-admin-token"];
  return typeof legacy === "string" ? legacy.trim() : "";
}

function parseJsonBody(body: Uint8Array | AsyncIterable<Uint8Array>): Record<string, unknown> {
  if (!(body instanceof Uint8Array)) throw new GatewayError("Streaming response is not supported in the playground", 502, "streaming_response");
  try {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    throw new GatewayError("Upstream returned an invalid JSON response", 502, "invalid_upstream_response");
  }
}

async function readExecutionBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  if (body instanceof Uint8Array) return parseJsonBody(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const raw = new TextDecoder().decode(concatBytes(chunks)).trim();
  if (!raw) throw new GatewayError("Streaming response was empty", 502, "empty_stream");
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Fall through to SSE parsing for a malformed-looking JSON fragment.
    }
  }
  const text = extractStreamText(raw);
  if (!text) throw new GatewayError("Upstream response did not contain assistant text", 502, "invalid_upstream_response");
  return { content: text };
}

function extractStreamText(raw: string): string {
  let text = "";
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!data) continue;
    const value = data.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    try {
      const payload = JSON.parse(value) as Record<string, unknown>;
      text += extractStreamDelta(payload);
    } catch {
      // Ignore incomplete or non-JSON SSE events.
    }
  }
  return text;
}

function extractStreamDelta(payload: Record<string, unknown>): string {
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.output_text === "string") return payload.output_text;
  const delta = payload.delta;
  if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).text === "string") return String((delta as Record<string, unknown>).text);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0];
  if (choice && typeof choice === "object") {
    const item = choice as Record<string, unknown>;
    const choiceDelta = item.delta;
    if (choiceDelta && typeof choiceDelta === "object" && typeof (choiceDelta as Record<string, unknown>).content === "string") return String((choiceDelta as Record<string, unknown>).content);
    const message = item.message;
    if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") return String((message as Record<string, unknown>).content);
  }
  const content = payload.content;
  if (Array.isArray(content)) return content.flatMap(readTextPart).join("");
  return typeof content === "string" ? content : "";
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  if (firstChoice && typeof firstChoice === "object") {
    const choice = firstChoice as Record<string, unknown>;
    const message = choice.message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.flatMap(readTextPart).join("\n");
    }
    if (typeof choice.text === "string") return choice.text;
  }
  const content = payload.content;
  if (Array.isArray(content)) return content.flatMap(readTextPart).join("\n");
  return typeof content === "string" ? content : "";
}

function readTextPart(part: unknown): string[] {
  if (!part || typeof part !== "object") return [];
  const text = (part as Record<string, unknown>).text;
  return typeof text === "string" ? [text] : [];
}

function toPlaygroundSessionMessage(message: {
  role: "system" | "user" | "assistant";
  content: string;
  model?: string | undefined;
  channelId?: string | undefined;
  channelName?: string | undefined;
  providerName?: string | undefined;
}): PlaygroundSessionMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.model ? { model: message.model } : {}),
    ...(message.channelId ? { channelId: message.channelId } : {}),
    ...(message.channelName ? { channelName: message.channelName } : {}),
    ...(message.providerName ? { providerName: message.providerName } : {}),
    createdAt: new Date().toISOString(),
  };
}

function sanitizeChannel<T extends { keyCiphertext: string }>(channel: T): Omit<T, "keyCiphertext"> & { maskedKey: string } {
  const { keyCiphertext: _secret, ...safe } = channel;
  return { ...safe, maskedKey: `••••••••${"keyLast4" in channel ? String(channel.keyLast4) : ""}` };
}

function sanitizeGatewayKey(key: { keyHash: string; name: string; id: string; keyLast4: string; enabled: boolean; createdAt: string; lastUsedAt: string | null }) {
  const { keyHash: _keyHash, ...safe } = key;
  return safe;
}
