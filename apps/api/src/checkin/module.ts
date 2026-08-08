import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChannelImportError, type OpsAgent } from "../agent/ops-agent.js";
import type { GatewayStore } from "../domain/store.js";
import { GatewayError } from "../gateway/errors.js";
import { BrowserManager } from "./browser-manager.js";
import { CheckinBalanceSync } from "./channel-balance.js";
import { CheckinCoordinator } from "./coordinator.js";
import { AuthAssistantService } from "./auth-assistant.js";
import { AppDatabase } from "./db.js";
import { EventBus } from "./events.js";
import { NewApiService } from "./new-api.js";
import { DailyScheduler } from "./scheduler.js";
import { isAllowedIconUrl, siteIconUrlMaxLength, SiteIconService } from "./site-icon.js";
import { initialSiteName } from "./site-name.js";
import { TelegramNotifier } from "./telegram.js";
import { normalizeBaseUrl, clampInteger } from "./utils.js";
import { resolveTelegramToken, settingsForClient } from "./settings-security.js";
import type { SecretBox } from "../security/secret-box.js";
import type { AppSettings } from "./types.js";

const faviconUrlSchema = z.union([z.string().trim().max(siteIconUrlMaxLength), z.null()]).superRefine((value, context) => {
  if (value === null || value === "") return;
  if (!isAllowedIconUrl(value)) context.addIssue({ code: "custom", message: "图标地址必须是安全的 HTTP(S) 地址或 Base64 图片" });
}).transform((value) => value || null);

const siteSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(500),
  note: z.string().trim().max(500).optional(),
  faviconUrl: faviconUrlSchema.optional(),
  checkinMode: z.enum(["checkin", "balance_only"]).default("checkin"),
});

const siteUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  note: z.string().trim().max(500).optional(),
  faviconUrl: faviconUrlSchema.optional(),
  enabled: z.boolean().optional(),
});

const settingsSchema = z.object({
  scheduleEnabled: z.boolean(),
  scheduleWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
  scheduleWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.literal("Asia/Shanghai"),
  retryCount: z.number().int().min(0).max(5),
  retryDelayMinutes: z.number().int().min(1).max(120),
  requestTimeoutSeconds: z.number().int().min(10).max(120),
  browserNotifications: z.boolean(),
  telegramEnabled: z.boolean(),
  telegramBotToken: z.string().trim().max(256),
  telegramChatId: z.string().trim().max(128),
  keepBrowserOpen: z.boolean(),
  historyRetentionDays: z.number().int().min(30).max(3650),
}).passthrough().superRefine((settings, context) => {
  if (!settings.telegramEnabled) return;
  if (!settings.telegramBotToken) context.addIssue({ code: "custom", path: ["telegramBotToken"], message: "启用 Telegram 前请填写 Bot Token" });
  if (!settings.telegramChatId) context.addIssue({ code: "custom", path: ["telegramChatId"], message: "启用 Telegram 前请填写 Chat ID" });
});

const channelImportConfirmSchema = z.object({
  candidateId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  models: z.array(z.string().trim().min(1)).max(500).default([]),
  priority: z.number().int().min(-100).max(100).default(0),
  weight: z.number().int().min(1).max(10_000).default(100),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const channelLinkSchema = z.object({
  channelId: z.string().uuid(),
});

const assistantClaimSchema = z.object({
  code: z.string().trim().min(6).max(16),
  hostname: z.string().trim().min(1).max(253),
});
const assistantPreviewSchema = z.object({
  code: z.string().trim().min(6).max(16),
});
const assistantUploadSchema = z.object({
  pairId: z.string().uuid(),
  iv: z.string().min(16).max(64),
  ciphertext: z.string().min(32).max(12 * 1024 * 1024),
});
const assistantFailureSchema = z.object({
  pairId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
});

export interface CheckinModule {
  interactiveAuthorizationEnabled: boolean;
  authAssistant: AuthAssistantService;
  db: AppDatabase;
  browser: BrowserManager;
  events: EventBus;
  newApi: NewApiService;
  coordinator: CheckinCoordinator;
  scheduler: DailyScheduler;
  siteIcons: SiteIconService;
  telegram: TelegramNotifier;
  balanceSync: CheckinBalanceSync;
  close(): Promise<void>;
}

export function createCheckinModule(
  store: GatewayStore,
  options: { interactiveAuthorizationEnabled?: boolean; secrets?: SecretBox } = {},
): CheckinModule {
  const interactiveAuthorizationEnabled = options.interactiveAuthorizationEnabled ?? true;
  const db = new AppDatabase();
  const browser = new BrowserManager();
  const events = new EventBus();
  const authAssistant = new AuthAssistantService(db, options.secrets ?? null, events);
  const newApi = new NewApiService(db, browser, events, {
    interactiveAuthorizationEnabled,
    authAssistant,
  });
  const siteIcons = new SiteIconService(db, fetch, browser);
  const telegram = new TelegramNotifier(db);
  const balanceSync = new CheckinBalanceSync(db, store);
  const coordinator = new CheckinCoordinator(db, newApi, events, telegram, balanceSync);
  const scheduler = new DailyScheduler(db, coordinator, events);
  scheduler.start();
  return {
    interactiveAuthorizationEnabled,
    authAssistant,
    db, browser, events, newApi, coordinator, scheduler, siteIcons, telegram, balanceSync,
    async close() {
      scheduler.stop();
      coordinator.stop();
      await browser.shutdown().catch(() => undefined);
      authAssistant.close();
      db.close();
    },
  };
}

export async function registerCheckinRoutes(
  app: FastifyInstance,
  module: CheckinModule,
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  dependencies: { agent: OpsAgent },
): Promise<void> {
  app.options("/auth-assistant/upload", async (request, reply) => {
    return reply
      .headers(assistantCorsHeaders(request.headers.origin))
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, x-autoapi-assistant-token")
      .send();
  });
  app.options("/auth-assistant/claim", async (request, reply) => {
    return reply
      .headers(assistantCorsHeaders(request.headers.origin))
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type")
      .send();
  });
  app.options("/auth-assistant/preview", async (request, reply) => {
    return reply
      .headers(assistantCorsHeaders(request.headers.origin))
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type")
      .send();
  });
  app.options("/auth-assistant/fail", async (request, reply) => {
    return reply
      .headers(assistantCorsHeaders(request.headers.origin))
      .header("access-control-allow-methods", "POST, OPTIONS")
      .header("access-control-allow-headers", "content-type, x-autoapi-assistant-token")
      .send();
  });
  app.post("/auth-assistant/claim", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 10 * 60_000,
      },
    },
  }, async (request, reply) => {
    const originHeaders = {
      "cache-control": "no-store",
      ...assistantCorsHeaders(request.headers.origin),
    };
    try {
      const body = assistantClaimSchema.parse(request.body);
      return reply.headers(originHeaders).send(module.authAssistant.claim(body.code, body.hostname));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法连接授权助手";
      return reply.code(/授权码|授权任务/.test(message) ? 401 : 400).headers(originHeaders).send({ error: { message, type: "assistant_claim_error" } });
    }
  });
  app.post("/auth-assistant/preview", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 10 * 60_000,
      },
    },
  }, async (request, reply) => {
    const originHeaders = {
      "cache-control": "no-store",
      ...assistantCorsHeaders(request.headers.origin),
    };
    try {
      const body = assistantPreviewSchema.parse(request.body);
      const preview = module.authAssistant.preview(body.code);
      return reply.headers(originHeaders).send(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "授权码不存在或已过期";
      return reply.code(/授权码|授权任务/.test(message) ? 401 : 400).headers(originHeaders).send({ error: { message, type: "assistant_preview_error" } });
    }
  });
  app.post("/auth-assistant/upload", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 10 * 60_000,
      },
    },
  }, async (request, reply) => {
    const originHeaders = {
      "cache-control": "no-store",
      ...assistantCorsHeaders(request.headers.origin),
    };
    try {
      const body = assistantUploadSchema.parse(request.body);
      const headerToken = typeof request.headers["x-autoapi-assistant-token"] === "string"
        ? request.headers["x-autoapi-assistant-token"].trim()
        : "";
      if (!headerToken) return reply.code(401).headers(originHeaders).send({ error: { message: "缺少授权助手上传 Token", type: "assistant_auth_error" } });
      const status = module.authAssistant.acceptUpload({ ...body, uploadToken: headerToken });
      return reply.headers(originHeaders).send({ status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "授权助手上传失败";
      return reply.code(/Token|授权任务|授权码/.test(message) ? 401 : 400).headers(originHeaders).send({ error: { message, type: "assistant_upload_error" } });
    }
  });
  app.post("/auth-assistant/fail", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 10 * 60_000,
      },
    },
  }, async (request, reply) => {
    const originHeaders = {
      "cache-control": "no-store",
      ...assistantCorsHeaders(request.headers.origin),
    };
    try {
      const body = assistantFailureSchema.parse(request.body);
      const headerToken = typeof request.headers["x-autoapi-assistant-token"] === "string"
        ? request.headers["x-autoapi-assistant-token"].trim()
        : "";
      if (!headerToken) return reply.code(401).headers(originHeaders).send({ error: { message: "缺少授权助手上传 Token", type: "assistant_auth_error" } });
      return reply.headers(originHeaders).send({ status: module.authAssistant.failPair({ ...body, uploadToken: headerToken }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "授权助手失败状态上报失败";
      return reply.code(/Token|授权任务/.test(message) ? 401 : 400).headers(originHeaders).send({ error: { message, type: "assistant_failure_error" } });
    }
  });

  await app.register(async (checkin) => {
    checkin.addHook("onRequest", requireAdmin);

    checkin.get("/state", async () => ({
      sites: module.db.listSites(),
      authSyncEvents: module.db.listAuthSyncEvents(),
      summary: module.db.getDashboardSummary(module.scheduler.getNextRunAt(), module.scheduler.isRunning()),
      recentResults: module.db.listResults({ limit: 50 }),
      recentDeletions: module.db.listSiteDeletionLogs(50),
      recentRuns: module.db.listRecentRuns(20),
      channelLinks: module.db.listChannelLinks(),
      settings: settingsForClient(module.db.getSettings()),
    }));

    checkin.get("/events", async (request, reply) => {
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      module.events.subscribe(response);
      request.raw.on("close", () => response.end());
    });

    checkin.get("/sites", async () => module.db.listSites());
    checkin.post("/sites", async (request, reply) => {
      const input = siteSchema.parse(request.body);
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const site = module.db.createSite(initialSiteName(baseUrl, input.name), baseUrl, input.note, input.faviconUrl, input.checkinMode);
      module.events.emit({ type: "state_changed", title: "站点已添加", message: `${site.name} 等待授权`, data: { siteId: site.id } });
      return reply.code(201).send(site);
    });
    checkin.post("/sites/bulk", async (request, reply) => {
      const bulkInput = z.object({
        urls: z.array(z.string()).min(1).max(100),
        checkinMode: z.enum(["checkin", "balance_only"]).default("checkin"),
      }).parse(request.body);
      const urls = bulkInput.urls;
      const existing = new Set(module.db.listSites().map((site) => site.baseUrl));
      const created = [];
      const skipped: Array<{ input: string; reason: string }> = [];
      for (const input of urls) {
        try {
          const baseUrl = normalizeBaseUrl(input);
          if (existing.has(baseUrl)) { skipped.push({ input, reason: "站点已存在" }); continue; }
          const site = module.db.createSite(initialSiteName(baseUrl), baseUrl, '', null, bulkInput.checkinMode);
          existing.add(baseUrl);
          created.push(site);
        } catch (error) { skipped.push({ input, reason: error instanceof Error ? error.message : "地址无效" }); }
      }
      return reply.code(201).send({ created, skipped });
    });
    checkin.patch<{ Params: { id: string } }>("/sites/:id", async (request) => {
      const input = siteUpdateSchema.parse(request.body);
      const id = parseId(request.params.id);
      const update: Parameters<AppDatabase["updateSite"]>[1] = {};
      if (input.name !== undefined) update.name = input.name;
      if (input.baseUrl !== undefined) update.baseUrl = normalizeBaseUrl(input.baseUrl);
      if (input.note !== undefined) update.note = input.note;
      if (input.faviconUrl !== undefined) update.faviconUrl = input.faviconUrl;
      if (input.enabled !== undefined) update.enabled = input.enabled;
      const site = module.db.updateSite(id, update);
      if (!site) throw new Error("站点不存在");
      if (input.faviconUrl !== undefined && site.faviconUrl) await module.siteIcons.getIconAsset(id, true);
      return site;
    });
    checkin.get<{ Params: { id: string } }>("/sites/:id/favicon", async (request, reply) => {
      const id = parseId(request.params.id);
      let url = await module.siteIcons.getIconUrl(id);
      if (!url) url = await module.siteIcons.getIconUrl(id, true);
      if (!url) return reply.code(404).send();
      const asset = await module.siteIcons.getIconAsset(id);
      if (!asset) return reply.redirect(url);
      reply.header("cache-control", "private, max-age=31536000, immutable").header("x-content-type-options", "nosniff").type(asset.contentType);
      return reply.send(Buffer.from(asset.body));
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/favicon/refresh", async (request) => {
      const id = parseId(request.params.id);
      await module.siteIcons.getIconUrl(id, true);
      await module.siteIcons.getIconAsset(id, true);
      return module.db.getSite(id);
    });
    checkin.delete<{ Params: { id: string } }>("/sites/:id", async (request, reply) => {
      try {
      let siteId: number;
      try {
        siteId = parseId(request.params.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid site id";
        return reply.code(400).send({ error: { message, type: "invalid_request" } });
      }
      if (!module.db.getSite(siteId)) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      if (module.coordinator.getActiveRun()?.id) {
        return reply.code(409).send({ error: { message: "签到任务正在运行，请完成后再删除站点", type: "conflict" } });
      }
      const cleanupWarnings: string[] = [];
      try {
        // Browser cleanup must never prevent the SQLite record from being removed.
        // A closing Chromium page can otherwise wait behind a navigation indefinitely.
        await withTimeout(module.newApi.cancelAuthorizationsForSite(siteId), 3_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown authorization cleanup error";
        cleanupWarnings.push(`authorization cleanup: ${message}`);
        request.log.warn({ siteId, error: message }, "Check-in authorization cleanup failed during site deletion");
      }
      try {
        module.authAssistant.cancelPairsForSite(siteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown assistant cleanup error";
        cleanupWarnings.push(`assistant cleanup: ${message}`);
        request.log.warn({ siteId, error: message }, "Authorization assistant cleanup failed during site deletion");
      }
      try {
        module.siteIcons.forgetSite(siteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown icon cleanup error";
        cleanupWarnings.push(`icon cleanup: ${message}`);
        request.log.warn({ siteId, error: message }, "Site icon cleanup failed during site deletion");
      }
      try {
        const deletionMessage = cleanupWarnings.length
          ? `站点已删除，运行时清理提示：${cleanupWarnings.join('；')}`
          : '站点已删除';
        if (!module.db.deleteSite(siteId, { message: deletionMessage })) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown database deletion error";
        request.log.error({ siteId, error: message }, "Check-in site deletion failed");
        return reply.code(500).send({ error: { message: `\u7AD9\u70B9\u5220\u9664\u5931\u8D25: ${message}`, type: "site_delete_error" } });
      }
      return cleanupWarnings.length ? { ok: true, warnings: cleanupWarnings } : { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown site deletion error";
        request.log.error({ path: request.url, error: message }, "Unhandled check-in site deletion error");
        return reply.code(500).send({ error: { message: `\u7AD9\u70B9\u5220\u9664\u5931\u8D25: ${message}`, type: "site_delete_error" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/channel-import/prepare", async (request, reply) => {
      const site = module.db.getSite(parseId(request.params.id));
      if (!site) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      try {
        const extraction = await module.newApi.extractOfficialApiKeys(site.id);
        if (!extraction.supported || extraction.keys.length === 0) {
          return reply.code(422).send({ error: { message: extraction.reason ?? "该站点暂不支持自动导入", type: "unsupported" } });
        }
        const candidates = [];
        let lastError: unknown = null;
        for (const key of extraction.keys) {
          try {
            candidates.push(await dependencies.agent.prepareChannelImport({
              siteId: site.id,
              siteName: site.name,
              keyName: key.name,
              baseUrl: extraction.baseUrl,
              apiKey: key.apiKey,
              protocol: extraction.protocol,
            }));
          } catch (error) {
            lastError = error;
          }
        }
        if (!candidates.length && lastError) throw lastError;
        return { candidates };
      } catch (error) {
        if (error instanceof ChannelImportError) {
          return reply.code(error.statusCode).send({ error: { message: error.message, type: error.errorType } });
        }
        return reply.code(502).send({ error: { message: error instanceof Error ? error.message : "无法读取站点官方 API Key", type: "validation_failed" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/channel-import/models", async (request, reply) => {
      const siteId = parseId(request.params.id);
      if (!module.db.getSite(siteId)) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      const input = z.object({ candidateId: z.string().uuid() }).parse(request.body);
      try {
        return await dependencies.agent.discoverChannelImportModels({ candidateId: input.candidateId, siteId });
      } catch (error) {
        if (error instanceof ChannelImportError) {
          return reply.code(error.statusCode).send({ error: { message: error.message, type: error.errorType } });
        }
        return reply.code(502).send({ error: { message: error instanceof Error ? error.message : "模型列表获取失败", type: "validation_failed" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/channel-import/confirm", async (request, reply) => {
      const siteId = parseId(request.params.id);
      if (!module.db.getSite(siteId)) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      const input = channelImportConfirmSchema.parse(request.body);
      try {
        const imported = await dependencies.agent.confirmChannelImport({ ...input, siteId });
        const linked = await module.balanceSync.linkChannel(siteId, imported.channel.id);
        return reply.code(201).send({
          action: imported.action,
          channel: sanitizeImportedChannel(linked.channel),
          probe: null,
        });
      } catch (error) {
        if (error instanceof ChannelImportError) {
          return reply.code(error.statusCode).send({ error: { message: error.message, type: error.errorType } });
        }
        return reply.code(502).send({ error: { message: error instanceof Error ? error.message : "渠道导入失败", type: "validation_failed" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/channel-link", async (request, reply) => {
      const siteId = parseId(request.params.id);
      if (!module.db.getSite(siteId)) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      const input = channelLinkSchema.parse(request.body);
      try {
        const linked = await module.balanceSync.linkChannel(siteId, input.channelId);
        return reply.code(201).send({
          link: module.db.listChannelLinks(siteId).find((item) => item.channelId === input.channelId) ?? null,
          channel: sanitizeImportedChannel(linked.channel),
          synced: linked.synced,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法关联渠道";
        const status = message === "Channel not found" ? 404 : 422;
        return reply.code(status).send({ error: { message, type: status === 404 ? "not_found" : "validation_failed" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/channel-balance/sync", async (request, reply) => {
      const siteId = parseId(request.params.id);
      if (!module.db.getSite(siteId)) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      try {
        const run = await module.coordinator.refreshBalance([siteId]);
        const result = module.db.listResults({ runId: run.id, limit: 1 })[0] ?? null;
        const synced = await module.balanceSync.syncSite(siteId);
        return reply.send({
          ...synced,
          refreshed: Boolean(result && result.balanceAfterAmount !== null && /余额已刷新|余额刷新成功|balance.*refresh/i.test(result.message)),
          result: result ? {
            status: result.status,
            message: result.message,
            balance: result.balanceAfterAmount,
            currency: module.db.getSite(siteId)?.currencySymbol ?? null,
          } : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法刷新站点余额";
        const status = /已有签到任务正在运行/.test(message) ? 409 : 502;
        return reply.code(status).send({ error: { message, type: status === 409 ? "conflict" : "balance_refresh_failed" } });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/authorize", async (request, reply) => {
      try {
        const siteId = parseId(request.params.id);
        if (!module.db.getSite(siteId)) {
          return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
        }
        return reply.code(202).send(module.newApi.startAuthorization(siteId));
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法启动站点授权";
        const statusCode = /已有授权窗口正在进行/.test(message)
          ? 409
          : /站点不存在|无效 ID/.test(message)
            ? 404
            : 503;
        return reply.code(statusCode).send({
          error: {
            message,
            type: "checkin_authorization_error",
          },
        });
      }
    });
    checkin.post<{ Params: { id: string } }>("/sites/:id/auth-assistant/pair", async (request, reply) => {
      const siteId = parseId(request.params.id);
      const site = module.db.getSite(siteId);
      if (!site) return reply.code(404).send({ error: { message: "站点不存在", type: "not_found" } });
      return module.authAssistant.createPair(site);
    });
    checkin.get<{ Params: { id: string; pairId: string } }>("/sites/:id/auth-assistant/pair/:pairId", async (request, reply) => {
      const siteId = parseId(request.params.id);
      const status = module.authAssistant.getPairStatus(request.params.pairId, siteId);
      if (!status) return reply.code(404).send({ error: { message: "授权任务不存在或已过期", type: "not_found" } });
      return status;
    });
    checkin.delete<{ Params: { id: string; pairId: string } }>("/sites/:id/auth-assistant/pair/:pairId", async (request, reply) => {
      const siteId = parseId(request.params.id);
      const status = module.authAssistant.cancelPair(request.params.pairId, siteId);
      if (!status) return reply.code(404).send({ error: { message: "授权任务不存在", type: "not_found" } });
      return status;
    });
    checkin.get<{ Params: { id: string } }>("/auth-sessions/:id", async (request, reply) => {
      const state = module.newApi.getAuthorization(request.params.id);
      if (!state) return reply.code(404).send({ error: "授权任务不存在" });
      return state;
    });
    checkin.delete<{ Params: { id: string } }>("/auth-sessions/:id", async (request, reply) => {
      const state = await module.newApi.cancelAuthorization(request.params.id);
      if (!state) return reply.code(404).send({ error: "授权任务不存在" });
      return state;
    });
    checkin.post("/checkin/run", async (request, reply) => {
      if (module.coordinator.getActiveRun()) return reply.code(409).send({ error: "已有签到任务正在运行" });
      const body = request.body as { siteIds?: unknown } | undefined;
      const siteIds = body?.siteIds === undefined ? undefined : z.array(z.number().int().positive()).max(100).parse(body.siteIds);
      const task = module.coordinator.run("manual", siteIds);
      void task.catch(() => undefined);
      return reply.code(202).send(module.coordinator.getActiveRun());
    });
    checkin.get<{ Querystring: { limit?: string } }>("/runs", async (request) => module.db.listRecentRuns(clampInteger(request.query.limit, 50, 1, 200)));
    checkin.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
      const run = module.db.getRun(parseId(request.params.id));
      if (!run) return reply.code(404).send({ error: "任务不存在" });
      return { run, results: module.db.listResults({ runId: run.id, limit: 500 }) };
    });
    checkin.get<{ Querystring: { limit?: string; siteId?: string } }>("/results", async (request) => module.db.listResults({ limit: clampInteger(request.query.limit, 200, 1, 1000), ...(request.query.siteId ? { siteId: parseId(request.query.siteId) } : {}) }));
    checkin.put("/settings", async (request, reply) => {
      const current = module.db.getSettings();
      const input = { ...(request.body as Record<string, unknown>), telegramBotToken: resolveTelegramToken((request.body as { telegramBotToken?: string })?.telegramBotToken, current.telegramBotToken) };
      const settings = settingsSchema.parse({ ...current, ...input }) as AppSettings;
      if (toMinutes(settings.scheduleWindowEnd) <= toMinutes(settings.scheduleWindowStart)) return reply.code(400).send({ error: "结束时间必须晚于开始时间" });
      const saved = module.db.saveSettings(settings);
      module.db.cleanupHistory(saved.historyRetentionDays);
      module.scheduler.reschedule();
      return settingsForClient(saved);
    });
    checkin.post("/settings/telegram/test", async (request) => {
      const current = module.db.getSettings();
      const body = request.body as { botToken?: string; chatId?: string };
      await module.telegram.sendTest({ telegramBotToken: resolveTelegramToken(body.botToken, current.telegramBotToken) ?? "", telegramChatId: body.chatId ?? current.telegramChatId });
      return { sent: true };
    });
    checkin.get<{ Querystring: { siteId?: string } }>("/export.csv", async (request, reply) => {
      const rows = module.db.listResults({ ...(request.query.siteId ? { siteId: parseId(request.query.siteId) } : {}), limit: 1000 });
      const lines = [["完成时间", "站点", "状态", "签到奖励", "余额变化", "消息"], ...rows.map((row) => [row.completedAt, row.siteName, row.status, row.rewardAmount ?? "", row.balanceDeltaAmount ?? "", row.message])];
      const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="checkin-history-${Date.now()}.csv"`).send(csv);
    });
}, { prefix: "/admin/checkin" });
}

function assistantCorsHeaders(origin: string | undefined): Record<string, string> {
  const headers = { "vary": "Origin" };
  if (!origin || !/^(?:chrome-extension:\/\/[a-z]{32}|moz-extension:\/\/[0-9a-f-]{36})$/i.test(origin)) {
    return headers;
  }
  return { ...headers, "access-control-allow-origin": origin };
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new GatewayError("无效 ID", 400, "invalid_request_error");
  return id;
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`运行时清理超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toMinutes(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeImportedChannel(channel: { id: string; name: string; providerName: string; baseUrl: string; protocol: string; keyLast4: string; models: string[]; status: string }) {
  return {
    id: channel.id,
    name: channel.name,
    providerName: channel.providerName,
    baseUrl: channel.baseUrl,
    protocol: channel.protocol,
    keyLast4: channel.keyLast4,
    models: channel.models,
    status: channel.status,
  };
}
