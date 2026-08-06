import type {
  Channel,
  ModelAliasInput,
  PoolSummary,
  ProbeResult,
  ProviderImportInput,
  ChannelUpdateInput,
  GatewayKey,
  GatewayKeySummary,
  RoutingCandidate,
  UsageEventInput,
  UsageSummary,
  PlaygroundSession,
  RequestLogFilters,
  RequestLogPage,
  AdminAccount,
  AdminLoginRecord,
} from "./types.js";

export interface ImportedProvider {
  providerId: string;
  channel: Channel;
}

export interface GatewayStore {
  importProvider(input: ProviderImportInput, encryptedKey: string, keyLast4: string, keyName?: string): Promise<ImportedProvider>;
  getChannel(id: string): Promise<Channel | null>;
  listChannels(): Promise<Channel[]>;
  reorderChannels(channelIds: string[]): Promise<Channel[]>;
  updateChannel(id: string, input: ChannelUpdateInput, encryptedKey?: string, keyLast4?: string, keyName?: string): Promise<Channel | null>;
  updateChannelBalance(id: string, balance: number, balanceCurrency: string | null): Promise<Channel | null>;
  deleteChannel(id: string): Promise<boolean>;
  setChannelEnabled(id: string, enabled: boolean): Promise<Channel | null>;
  listRoutingCandidates(modelAlias: string): Promise<RoutingCandidate[]>;
  saveModelAlias(input: ModelAliasInput): Promise<void>;
  applyProbeResult(channelId: string, result: ProbeResult, failureThreshold: number): Promise<Channel>;
  recordChannelFailure(channelId: string, reason: string, failureThreshold: number): Promise<void>;
  recordChannelSuccess(channelId: string, latencyMs: number): Promise<void>;
  recordUsage(event: UsageEventInput): Promise<void>;
  listRequestLogs(filters: RequestLogFilters): Promise<RequestLogPage>;
  listPlaygroundSessions(limit?: number): Promise<PlaygroundSession[]>;
  getPlaygroundSession(id: string): Promise<PlaygroundSession | null>;
  savePlaygroundSession(session: PlaygroundSession): Promise<PlaygroundSession>;
  deletePlaygroundSession(id: string): Promise<boolean>;
  getPools(): Promise<PoolSummary[]>;
  getUsage(window: "1h" | "24h" | "7d"): Promise<UsageSummary>;
  getBalances(): Promise<Channel[]>;
  listHealthCheckChannels(): Promise<Channel[]>;
  listGatewayKeys(): Promise<GatewayKeySummary[]>;
  findGatewayKey(keyHash: string): Promise<GatewayKeySummary | null>;
  createGatewayKey(name: string, keyHash: string, keyLast4: string): Promise<GatewayKey>;
  deleteGatewayKey(id: string): Promise<boolean>;
  hasGatewayKey(keyHash: string): Promise<boolean>;
  getAdminAccount(): Promise<AdminAccount | null>;
  saveAdminAccount(account: AdminAccount): Promise<AdminAccount>;
  recordAdminLogin(record: Omit<AdminLoginRecord, "id">): Promise<AdminLoginRecord>;
  listAdminLoginHistory(limit?: number): Promise<AdminLoginRecord[]>;
  close(): Promise<void>;
}
