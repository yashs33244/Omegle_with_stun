/**
 * SessionKv on the server's shared Redis client. Keys are `<prefix><key>`
 * strings with a TTL; counters keep the TTL of their first increment.
 */
import type Redis from "ioredis";
import { SESSION_KEY_PREFIX } from "./constants";
import type { SessionKv } from "./SessionKv";

export class RedisKv implements SessionKv {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = SESSION_KEY_PREFIX,
  ) {}

  async incr(key: string, ttlMs: number): Promise<number> {
    const k = this.prefix + key;
    const res = await this.redis.multi().incr(k).pexpire(k, ttlMs, "NX").exec();
    const [err, value] = res?.[0] ?? [new Error("redis transaction aborted"), null];
    if (err) throw err;
    return Number(value);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.prefix + key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(this.prefix + key, value, "PX", ttlMs);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.redis.mget(...keys.map((k) => this.prefix + k));
  }
}
