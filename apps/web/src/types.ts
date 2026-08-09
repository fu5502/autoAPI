export type ChannelStatus = "pending" | "healthy" | "degraded" | "isolated" | "disabled";

export interface Channel {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  baseUrl: string;
  faviconUrl: string | null;
  protocol: string;
  keyName?: string;
  maskedKey: string;
  keyLast4: string;
  status: ChannelStatus;
  enabled: boolean;
  priority: number;
  weight: number;
  minBalance: number | null;
  balance: number | null;
  balanceCurrency: string | null;
  balanceUpdatedAt?: string | null;
  balanceStatus: "ok" | "low" | "exhausted" | "unknown" | "error";
  consecutiveFailures: number;
  cooldownUntil: string | null;
  isolationReason: string | null;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  recentRequestCount: number;
  recentErrorRate: number;
  models: string[];
  tags: string[];
  createdAt: string;
  checkinSite: {
    id: number;
    name: string;
    baseUrl: string;
    faviconUrl: string | null;
    lastBalanceUpdatedAt?: string | null;
    updatedAt: string;
  } | null;
}

export interface Pool {
  alias: string;
  channels: number;
  healthyChannels: number;
  totalRequests1h: number;
  errorRate1h: number;
  averageLatencyMs1h: number;
  requests24h: number;
  successfulRequests24h: number;
  successRate24h: number | null;
  requests6h: number;
  successfulRequests6h: number;
  successRate6h: number | null;
  requests15m: number;
  averageLatencyMs15m: number;
  peakLatencyMs15m: number;
  health1h: Array<{
    bucket: string;
    requests: number;
    successfulRequests: number;
    successRate: number | null;
    averageLatencyMs: number;
    peakLatencyMs: number;
    status: "available" | "degraded" | "abnormal" | "no_request";
  }>;
  hourlyHealth: Array<{
    bucket: string;
    requests: number;
    successfulRequests: number;
    successRate: number | null;
    averageLatencyMs: number;
    peakLatencyMs: number;
    status: "available" | "degraded" | "abnormal" | "no_request";
  }>;
  recentHealth: Pool["hourlyHealth"];
  health12h: Pool["hourlyHealth"];
  health7d: Pool["hourlyHealth"];
  routes: Array<{
    channelId: string;
    channelName: string;
    providerName: string;
    upstreamModel: string;
    status: ChannelStatus;
    priority: number;
    weight: number;
    lastRequestedAt?: string | null;
    conversationLatencyMs: number | null;
    endpointPingMs: number | null;
    health1h: Pool["hourlyHealth"];
    hourlyHealth: Pool["hourlyHealth"];
    recentHealth: Pool["hourlyHealth"];
    health12h: Pool["hourlyHealth"];
    health7d: Pool["hourlyHealth"];
  }>;
}

export interface Usage {
  window: "1h" | "24h" | "7d";
  totalRequests: number;
  successfulRequests: number;
  errorRate: number;
  averageLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  byModel: Array<{ name: string; requests: number; errors: number; latencyMs: number }>;
  byChannel: Array<{ name: string; requests: number; errors: number; latencyMs: number }>;
  byClient: Array<{ name: string; requests: number; errors: number; latencyMs: number }>;
  byError: Array<{ name: string; requests: number; errors: number; latencyMs: number }>;
  timeline: Array<{ bucket: string; requests: number; errors: number }>;
}

export interface RequestLogEntry {
  id: string;
  requestId: string;
  createdAt: string;
  channelId: string | null;
  channelName: string | null;
  providerName: string | null;
  keyName?: string | null;
  gatewayKeyName?: string | null;
  reasoningEffort?: string | null;
  modelAlias: string;
  upstreamModel: string | null;
  clientName: string;
  sourceIp: string | null;
  requestKind: "chat" | "responses" | "messages";
  endpoint: string;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  firstByteLatencyMs: number | null;
  errorType: string | null;
  retryCount: number;
  streamed: boolean;
}

export interface RequestLogPage {
  items: RequestLogEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  filterOptions: {
    clients: string[];
    channels: string[];
    models: string[];
    sourceIps: string[];
  };
}

export interface GatewayStatus {
  status: string;
  channels: number;
  healthyChannels: number;
  isolatedChannels: number;
  modelPools: number;
  requests1h: number;
  errorRate1h: number;
  averageLatencyMs1h: number;
  requests24h: number;
  errorRate24h: number;
  averageLatencyMs24h: number;
  gatewayBaseUrl: string;
  version: string;
}

export interface GatewayKeySummary {
  id: string;
  name: string;
  keyLast4: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedGatewayKey {
  key: string;
  gatewayKey: GatewayKeySummary;
}

export interface PlaygroundResponse {
  sessionId: string;
  message: string;
  model: string;
  channelId: string;
  channelName: string;
  providerName: string;
  latencyMs: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface PlaygroundSessionMessage {
  role: "system" | "user" | "assistant";
  content: string;
  model?: string;
  channelId?: string;
  channelName?: string;
  providerName?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  errorType?: string;
  createdAt: string;
}

export interface PlaygroundSession {
  id: string;
  channelId: string | null;
  channelName: string;
  providerName: string;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  stream?: boolean;
  messages: PlaygroundSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelDiscoveryResult {
  protocol: string;
  models: string[];
  error: string | null;
}

export interface ProbeResult {
  ok: boolean;
  protocol: string;
  models: string[];
  latencyMs: number;
  chatOk: boolean;
  streamOk: boolean;
  balance: number | null;
  balanceCurrency: string | null;
  balanceStatus: "ok" | "low" | "exhausted" | "unknown" | "error";
  error: string | null;
  modelsChanged?: boolean;
}

export interface ProbeResponse {
  channel: Channel | null;
  probe: ProbeResult;
}

export type View = "overview" | "channels" | "pools" | "usage" | "requests" | "playground" | "checkin" | "security";

export interface AdminLoginRecord {
  id: string;
  username: string;
  ip: string;
  userAgent: string;
  success: boolean;
  reason: string | null;
  createdAt: string;
}
