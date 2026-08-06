import { Redis } from "ioredis";

export interface RoutingHint {
  preferredChannelId: string | null;
  channelPenalties: Readonly<Record<string, number>>;
}

export interface RuntimeState {
  nextCounter(key: string): Promise<number>;
  getRoutingHint(key: string, channelIds: readonly string[]): Promise<RoutingHint>;
  recordRoutingSuccess(key: string, channelId: string): Promise<void>;
  recordRoutingFailure(key: string, channelId: string): Promise<void>;
  close(): Promise<void>;
}

const PREFERRED_CHANNEL_TTL_MS = 60 * 60 * 1_000;
const PREFERRED_CHANNEL_TTL_SECONDS = PREFERRED_CHANNEL_TTL_MS / 1_000;
const MAX_PENALTY_TTL_SECONDS = 5 * 60;

type InMemoryRouteState = {
  preferredChannelId: string | null;
  preferredUntil: number;
  penalties: Map<string, { score: number; expiresAt: number }>;
};

export class MemoryRuntimeState implements RuntimeState {
  private readonly counters = new Map<string, number>();
  private readonly routing = new Map<string, InMemoryRouteState>();

  async nextCounter(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? -1) + 1;
    this.counters.set(key, next);
    return next;
  }

  async getRoutingHint(key: string, channelIds: readonly string[]): Promise<RoutingHint> {
    const state = this.routing.get(key);
    if (!state) return { preferredChannelId: null, channelPenalties: {} };

    const now = Date.now();
    if (state.preferredUntil <= now) state.preferredChannelId = null;
    const channelPenalties: Record<string, number> = {};
    for (const [channelId, penalty] of state.penalties) {
      if (penalty.expiresAt <= now) {
        state.penalties.delete(channelId);
        continue;
      }
      if (channelIds.includes(channelId)) channelPenalties[channelId] = penalty.score;
    }
    return { preferredChannelId: state.preferredChannelId, channelPenalties };
  }

  async recordRoutingSuccess(key: string, channelId: string): Promise<void> {
    const state = this.getRouteState(key);
    state.preferredChannelId = channelId;
    state.preferredUntil = Date.now() + PREFERRED_CHANNEL_TTL_MS;
    state.penalties.delete(channelId);
  }

  async recordRoutingFailure(key: string, channelId: string): Promise<void> {
    const state = this.getRouteState(key);
    const now = Date.now();
    const previous = state.penalties.get(channelId);
    const score = Math.min(4, previous && previous.expiresAt > now ? previous.score + 1 : 1);
    state.penalties.set(channelId, {
      score,
      expiresAt: now + penaltyTtlSeconds(score) * 1_000,
    });
    if (state.preferredChannelId === channelId) {
      state.preferredChannelId = null;
      state.preferredUntil = 0;
    }
  }

  async close(): Promise<void> {}

  private getRouteState(key: string): InMemoryRouteState {
    const existing = this.routing.get(key);
    if (existing) return existing;
    const state: InMemoryRouteState = {
      preferredChannelId: null,
      preferredUntil: 0,
      penalties: new Map(),
    };
    this.routing.set(key, state);
    return state;
  }
}

export class RedisRuntimeState implements RuntimeState {
  private constructor(private readonly redis: Redis) {}

  static async connect(url: string): Promise<RedisRuntimeState> {
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    await redis.ping();
    return new RedisRuntimeState(redis);
  }

  async nextCounter(key: string): Promise<number> {
    const redisKey = `autoapi:route:${key}`;
    const value = await this.redis.incr(redisKey);
    if (value === 1) await this.redis.expire(redisKey, 86_400);
    return value - 1;
  }

  async getRoutingHint(key: string, channelIds: readonly string[]): Promise<RoutingHint> {
    if (channelIds.length === 0) return { preferredChannelId: null, channelPenalties: {} };
    const routeKey = redisRouteKey(key);
    const values = await this.redis.mget([
      `autoapi:route:preferred:${routeKey}`,
      ...channelIds.map((channelId) => `autoapi:route:penalty:${routeKey}:${channelId}`),
    ]);
    const [preferredChannelId, ...penalties] = values;
    const channelPenalties: Record<string, number> = {};
    channelIds.forEach((channelId, index) => {
      const score = Number(penalties[index] ?? 0);
      if (Number.isFinite(score) && score > 0) channelPenalties[channelId] = score;
    });
    return { preferredChannelId: preferredChannelId ?? null, channelPenalties };
  }

  async recordRoutingSuccess(key: string, channelId: string): Promise<void> {
    const routeKey = redisRouteKey(key);
    await Promise.all([
      this.redis.set(`autoapi:route:preferred:${routeKey}`, channelId, "EX", PREFERRED_CHANNEL_TTL_SECONDS),
      this.redis.del(`autoapi:route:penalty:${routeKey}:${channelId}`),
    ]);
  }

  async recordRoutingFailure(key: string, channelId: string): Promise<void> {
    const routeKey = redisRouteKey(key);
    const preferredKey = `autoapi:route:preferred:${routeKey}`;
    const penaltyKey = `autoapi:route:penalty:${routeKey}:${channelId}`;
    const score = await this.redis.incr(penaltyKey);
    await Promise.all([
      this.redis.expire(penaltyKey, penaltyTtlSeconds(score)),
      this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        preferredKey,
        channelId,
      ),
    ]);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

function penaltyTtlSeconds(score: number): number {
  return Math.min(MAX_PENALTY_TTL_SECONDS, 30 * 2 ** Math.min(Math.max(score - 1, 0), 3));
}

function redisRouteKey(key: string): string {
  return encodeURIComponent(key);
}
