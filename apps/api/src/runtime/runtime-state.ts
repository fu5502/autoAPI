import { Redis } from "ioredis";

export interface RuntimeState {
  nextCounter(key: string): Promise<number>;
  close(): Promise<void>;
}

export class MemoryRuntimeState implements RuntimeState {
  private readonly counters = new Map<string, number>();

  async nextCounter(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? -1) + 1;
    this.counters.set(key, next);
    return next;
  }

  async close(): Promise<void> {}
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

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
