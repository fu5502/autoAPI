export type Protocol = "auto" | "openai" | "claude" | "gemini" | "new-api" | "sub2api";
export type WireProtocol = "openai" | "claude" | "gemini";
export type ChannelStatus = "pending" | "healthy" | "degraded" | "isolated" | "disabled";
export type BalanceStatus = "ok" | "low" | "exhausted" | "unknown" | "error";
export type RequestKind = "chat" | "responses" | "messages";

export interface GatewayKey {
  id: string;
  name: string;
  keyHash: string;
  keyLast4: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface GatewayKeySummary {
  id: string;
  name: string;
  keyLast4: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminAccount {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLoginRecord {
  id: string;
  username: string;
  ip: string;
  userAgent: string;
  success: boolean;
  reason: string | null;
  createdAt: string;
}

export interface Provider {
  id: string;
  name: string;
  website: string | null;
  tags: string[];
  createdAt: string;
}

export interface Channel {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  baseUrl: string;
  faviconUrl: string | null;
  protocol: Protocol;
  keyCiphertext: string;
  keyName?: string;
  keyLast4: string;
  status: ChannelStatus;
  enabled: boolean;
  priority: number;
  weight: number;
  minBalance: number | null;
  balance: number | null;
  balanceCurrency: string | null;
  /** Time when the displayed balance was last refreshed successfully or edited. */
  balanceUpdatedAt?: string | null;
  balanceStatus: BalanceStatus;
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
}

export interface ModelRoute {
  id: string;
  alias: string;
  channelId: string;
  upstreamModel: string;
  enabled: boolean;
}

export interface RoutingCandidate {
  channel: Channel;
  upstreamModel: string;
}

export type PoolHealthStatus = "available" | "degraded" | "abnormal" | "no_request";

export interface PoolHealthPoint {
  bucket: string;
  requests: number;
  successfulRequests: number;
  successRate: number | null;
  averageLatencyMs: number;
  peakLatencyMs: number;
  status: PoolHealthStatus;
}

export interface PoolHealthMetrics {
  requests24h: number;
  successfulRequests24h: number;
  successRate24h: number | null;
  requests6h: number;
  successfulRequests6h: number;
  successRate6h: number | null;
  requests15m: number;
  averageLatencyMs15m: number;
  peakLatencyMs15m: number;
  health1h: PoolHealthPoint[];
  hourlyHealth: PoolHealthPoint[];
  recentHealth: PoolHealthPoint[];
  health12h: PoolHealthPoint[];
  health7d: PoolHealthPoint[];
}

export interface GatewayRequest {
  requestId: string;
  kind: RequestKind;
  model: string;
  stream: boolean;
  body: Record<string, unknown>;
  clientName: string;
  endpoint?: string;
  sourceIp?: string | null;
  /** Name of the autoAPI gateway key used by the client. */
  gatewayKeyName?: string | null;
  /** Requested reasoning level, when supplied by an OpenAI-compatible client. */
  reasoningEffort?: string | null;
  /** Selected client/protocol headers that are safe to forward upstream. */
  protocolHeaders?: Record<string, string>;
}

export interface UpstreamResult {
  channelId: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | AsyncIterable<Uint8Array>;
  streaming: boolean;
}

export interface UsageEventInput {
  requestId: string;
  channelId: string | null;
  modelAlias: string;
  upstreamModel: string | null;
  clientName: string;
  requestKind: RequestKind;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  errorType: string | null;
  errorDetail?: string | null;
  retryCount: number;
  streamed: boolean;
  endpoint?: string | null;
  sourceIp?: string | null;
  gatewayKeyName?: string | null;
  reasoningEffort?: string | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
  firstByteLatencyMs?: number | null;
}

export interface RequestLogEntry {
  id: string;
  requestId: string;
  createdAt: string;
  channelId: string | null;
  channelName: string | null;
  providerName: string | null;
  keyName: string | null;
  gatewayKeyName: string | null;
  reasoningEffort: string | null;
  modelAlias: string;
  upstreamModel: string | null;
  clientName: string;
  sourceIp: string | null;
  requestKind: RequestKind;
  endpoint: string;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  firstByteLatencyMs: number | null;
  errorType: string | null;
  errorDetail?: string | null;
  retryCount: number;
  streamed: boolean;
}

export interface RequestLogFilters {
  limit: number;
  offset: number;
  window: "1h" | "24h" | "7d";
  client?: string;
  channel?: string;
  model?: string;
  sourceIp?: string;
  localOnly?: boolean;
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

export interface ProbeResult {
  ok: boolean;
  protocol: Protocol;
  models: string[];
  latencyMs: number;
  chatOk: boolean;
  streamOk: boolean;
  balance: number | null;
  balanceCurrency: string | null;
  balanceStatus: BalanceStatus;
  error: string | null;
  errorType?: string | null;
  modelsChanged?: boolean;
  probedModel?: string | null;
  probeReply?: string | null;
  probeEndpoint?: string | null;
  probeRequestBody?: string | null;
  probeResponseRaw?: string | null;
}

export interface PoolSummary {
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
  health1h: PoolHealthPoint[];
  hourlyHealth: PoolHealthPoint[];
  recentHealth: PoolHealthPoint[];
  health12h: PoolHealthPoint[];
  health7d: PoolHealthPoint[];
  routes: PoolRouteSummary[];
}

export interface PoolRouteSummary {
  channelId: string;
  channelName: string;
  providerName: string;
  upstreamModel: string;
  status: ChannelStatus;
  priority: number;
  weight: number;
  /** Most recent request timestamp for this model/channel route. */
  lastRequestedAt?: string | null;
  conversationLatencyMs: number | null;
  endpointPingMs: number | null;
  health1h: PoolHealthPoint[];
  hourlyHealth: PoolHealthPoint[];
  recentHealth: PoolHealthPoint[];
  health12h: PoolHealthPoint[];
  health7d: PoolHealthPoint[];
}

export interface UsageSummary {
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

export type PlaygroundMessageRole = "system" | "user" | "assistant";

export interface PlaygroundSessionMessage {
  role: PlaygroundMessageRole;
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

export interface ProviderImportInput {
  name: string;
  channelName?: string | undefined;
  keyName?: string | undefined;
  website?: string | undefined;
  baseUrl: string;
  faviconUrl?: string | null | undefined;
  apiKey: string;
  protocol: Protocol;
  models?: string[] | undefined;
  priority: number;
  weight: number;
  minBalance?: number | undefined;
  tags: string[];
}

export interface ChannelUpdateInput {
  name: string;
  baseUrl: string;
  faviconUrl?: string | null | undefined;
  keyName?: string | undefined;
  apiKey?: string | undefined;
  protocol: Protocol;
  models: string[];
  priority: number;
  weight: number;
  minBalance: number | null;
  balance?: number | null | undefined;
  balanceCurrency?: string | null | undefined;
  tags: string[];
  enabled?: boolean | undefined;
}

export interface ProviderProbeInput {
  baseUrl: string;
  apiKey: string;
  protocol: Protocol;
  models: string[];
}

export interface ChannelModelDiscoveryInput {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  protocol?: Protocol | undefined;
}

export interface ModelDiscoveryResult {
  protocol: Protocol;
  models: string[];
  error: string | null;
}

export interface ModelAliasInput {
  alias: string;
  channelId: string;
  upstreamModel: string;
  enabled?: boolean;
}
