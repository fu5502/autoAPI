import type { AdminLoginRecord, Channel, CreatedGatewayKey, GatewayKeySummary, GatewayLogEntry, GatewayStatus, LogPage, ModelDiscoveryResult, PlaygroundResponse, PlaygroundSession, Pool, ProbeResponse, RequestLogPage, SystemLogEntry, Usage } from "./types";

const tokenKey = "autoapi-admin-session";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function getAdminToken(): string {
  return localStorage.getItem(tokenKey) ?? "";
}

export function setAdminToken(token: string): void {
  localStorage.setItem(tokenKey, token);
}

export function hasAdminSession(): boolean {
  return Boolean(getAdminToken());
}

export function clearAdminSession(): void {
  localStorage.removeItem(tokenKey);
}

async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/admin${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(body?.error?.message ?? "登录失败", response.status);
  }
  return response.json() as Promise<T>;
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    authorization: `Bearer ${getAdminToken()}`,
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...init?.headers,
  };
  const response = await fetch(`/admin${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(translateApiError(body?.error?.message, response.status), response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function adminStream<T>(path: string, body: Record<string, unknown>, onDelta?: (delta: string) => void): Promise<T> {
  const response = await fetch(`/admin${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getAdminToken()}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(translateApiError(payload?.error?.message, response.status), response.status);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json() as Promise<T>;
  if (!response.body) throw new ApiError("流式响应不可读取", 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  while (true) {
    const part = await reader.read();
    buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === "delta" && typeof payload.delta === "string") onDelta?.(payload.delta);
      if (event === "done") result = payload as T;
      if (event === "error") throw new ApiError(typeof payload.message === "string" ? payload.message : "流式测试失败", 502);
    }
    if (part.done) break;
  }
  if (!result) throw new ApiError("流式响应未正常结束", 502);
  return result;
}

function translateApiError(message: string | undefined, status: number) {
  if (!message) return `请求失败（HTTP ${status}）`;
  const labels: Record<string, string> = {
    Unauthorized: "未授权，请检查管理员令牌。",
    "Channel not found": "找不到该渠道。",
    "Channel not found after probe": "探测完成后找不到该渠道。",
    "Provider import failed": "渠道导入失败。",
    "Gateway key not found": "访问密钥不存在。",
    "Gateway key ciphertext is missing": "此密钥创建于较早版本，无法查看明文，请删除后重新创建。",
    "At least one gateway key must remain": "至少保留一个可用访问密钥。",
    "Gateway key already exists": "该访问密钥已经存在。",
    "Selected model is not configured for this channel": "该模型未配置在所选渠道中。",
    "Channel is disabled": "所选渠道已停用。",
    "Selected channel protocol does not support this test request": "所选渠道协议不支持此测试请求。",
  };
  return labels[message] ?? message;
}

export const api = {
  status: () => adminFetch<GatewayStatus>("/status"),
  login: (body: { username: string; password: string }) => publicFetch<{ token: string; username: string; expiresAt: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((result) => {
    setAdminToken(result.token);
    return result;
  }),
  me: () => adminFetch<{ username: string }>("/auth/me"),
  loginHistory: () => adminFetch<AdminLoginRecord[]>("/security/login-history"),
  changePassword: (body: { currentPassword: string; newPassword: string }) => adminFetch<{ ok: true; token: string; username: string; expiresAt: string }>("/security/password", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((result) => {
    setAdminToken(result.token);
    return result;
  }),
  gatewayKeys: () => adminFetch<GatewayKeySummary[]>("/gateway-keys"),
  revealGatewayKey: (id: string) => adminFetch<{ key: string }>(`/gateway-keys/${id}/reveal`),
  createGatewayKey: (body: { name: string; key?: string }) => adminFetch<CreatedGatewayKey>("/gateway-keys", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  deleteGatewayKey: (id: string) => adminFetch<void>(`/gateway-keys/${id}`, { method: "DELETE" }),
  channels: () => adminFetch<Channel[]>("/channels"),
  reorderChannels: (channelIds: string[]) => adminFetch<{ channels: Channel[] }>("/channels/reorder", {
    method: "POST",
    body: JSON.stringify({ channelIds }),
  }),
  updateChannel: (id: string, body: Record<string, unknown>) => adminFetch<{ channel: Channel }>(`/channels/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteChannel: (id: string) => adminFetch<void>(`/channels/${id}`, { method: "DELETE" }),
  setChannelEnabled: (id: string, enabled: boolean) => adminFetch<{ channel: Channel }>(`/channels/${id}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }),
  pools: () => adminFetch<Pool[]>("/pools"),
  usage: (window: Usage["window"]) => adminFetch<Usage>(`/usage?window=${window}`),
  requests: (params: { limit: number; offset: number; window: Usage["window"]; client?: string; channel?: string; model?: string; sourceIp?: string; localOnly?: boolean }) => {
    const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset), window: params.window });
    for (const [key, value] of Object.entries(params)) {
      if (key === "limit" || key === "offset" || key === "window" || typeof value !== "string" || !value) continue;
      query.set(key, value);
    }
    if (params.localOnly) query.set("localOnly", "true");
    return adminFetch<RequestLogPage>(`/requests?${query.toString()}`);
  },
  gatewayLogs: (params: { limit: number; offset: number; model?: string; channel?: string; statusCode?: string; errorType?: string }) => {
    const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    for (const [key, value] of Object.entries(params)) {
      if (key === "limit" || key === "offset" || typeof value !== "string" || !value) continue;
      query.set(key, value);
    }
    return adminFetch<LogPage<GatewayLogEntry>>(`/gateway-logs?${query.toString()}`);
  },
  systemLogs: (params: { limit: number; offset: number; level?: string; source?: string }) => {
    const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    for (const [key, value] of Object.entries(params)) {
      if (key === "limit" || key === "offset" || typeof value !== "string" || !value) continue;
      query.set(key, value);
    }
    return adminFetch<LogPage<SystemLogEntry>>(`/system-logs?${query.toString()}`);
  },
  logSettings: () => adminFetch<{ retentionDays: number }>("/logs/settings"),
  updateLogSettings: (retentionDays: number) => adminFetch<{ retentionDays: number }>("/logs/settings", {
    method: "POST",
    body: JSON.stringify({ retentionDays }),
  }),
  clearAllLogs: () => adminFetch<{ removed: number }>("/logs/clear-all", { method: "POST", body: JSON.stringify({}) }),
  playgroundChat: (body: Record<string, unknown>, onDelta?: (delta: string) => void) => body.stream === true
    ? adminStream<PlaygroundResponse>("/playground/chat", body, onDelta)
    : adminFetch<PlaygroundResponse>("/playground/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  playgroundSessions: () => adminFetch<PlaygroundSession[]>("/playground/sessions?limit=50"),
  deletePlaygroundSession: (id: string) => adminFetch<void>(`/playground/sessions/${id}`, { method: "DELETE" }),
  probe: (channelId: string) => adminFetch<ProbeResponse>(`/channels/${channelId}/probe`, { method: "POST" }),
  refreshChannelBalances: () => adminFetch<{
    refreshedChannelIds: string[];
    unknownChannelIds: string[];
    failures: Array<{ channelId?: string; siteId?: number; name: string; message: string }>;
    summary: { total: number; refreshed: number; unknown: number; failed: number };
  }>("/channels/balances/refresh", { method: "POST", body: JSON.stringify({}) }),
  discoverChannelModels: (channelId: string, body: Record<string, unknown> = {}) => adminFetch<ModelDiscoveryResult>(`/channels/${channelId}/models`, {
    method: "POST",
    body: JSON.stringify(body),
  }),
  syncCheckinSiteBalance: (siteId: number) => adminFetch<{ updatedChannelIds: string[]; skippedBecauseBalanceIsUnknown: boolean; refreshed: boolean; result: { status: string; message: string; balance: number | null; currency: string | null } | null }>(`/checkin/sites/${siteId}/channel-balance/sync`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  importProvider: (body: Record<string, unknown>) => adminFetch<{ providerId: string; channel: Channel }>("/providers/import", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  discoverModels: (body: Record<string, unknown>) => adminFetch<ModelDiscoveryResult>("/providers/models", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  addAlias: (body: Record<string, unknown>) => adminFetch("/model-aliases", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
