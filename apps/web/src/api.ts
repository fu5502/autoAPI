import type { AdminLoginRecord, Channel, CreatedGatewayKey, GatewayKeySummary, GatewayStatus, ModelDiscoveryResult, PlaygroundResponse, PlaygroundSession, Pool, ProbeResponse, RequestLogPage, Usage } from "./types";

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

function translateApiError(message: string | undefined, status: number) {
  if (!message) return `请求失败（HTTP ${status}）`;
  const labels: Record<string, string> = {
    Unauthorized: "未授权，请检查管理员令牌。",
    "Channel not found": "找不到该渠道。",
    "Channel not found after probe": "探测完成后找不到该渠道。",
    "Provider import failed": "渠道导入失败。",
    "Gateway key not found": "访问密钥不存在。",
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
  changePassword: (body: { currentPassword: string; newPassword: string }) => adminFetch<{ ok: true }>("/security/password", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  gatewayKeys: () => adminFetch<GatewayKeySummary[]>("/gateway-keys"),
  createGatewayKey: (body: { name: string; key?: string }) => adminFetch<CreatedGatewayKey>("/gateway-keys", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  deleteGatewayKey: (id: string) => adminFetch<void>(`/gateway-keys/${id}`, { method: "DELETE" }),
  channels: () => adminFetch<Channel[]>("/channels"),
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
  playgroundChat: (body: Record<string, unknown>) => adminFetch<PlaygroundResponse>("/playground/chat", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  playgroundSessions: () => adminFetch<PlaygroundSession[]>("/playground/sessions?limit=50"),
  deletePlaygroundSession: (id: string) => adminFetch<void>(`/playground/sessions/${id}`, { method: "DELETE" }),
  probe: (channelId: string) => adminFetch<ProbeResponse>(`/channels/${channelId}/probe`, { method: "POST" }),
  discoverChannelModels: (channelId: string, body: Record<string, unknown> = {}) => adminFetch<ModelDiscoveryResult>(`/channels/${channelId}/models`, {
    method: "POST",
    body: JSON.stringify(body),
  }),
  importProvider: (body: Record<string, unknown>) => adminFetch("/providers/import", {
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
