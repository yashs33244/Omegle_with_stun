/**
 * Tiny key-value store for the session gate: lockouts, rate-limit windows and
 * hourly match caps. Memory for a single instance, Redis (the server's shared
 * client) when several replicas run.
 */
import type Redis from "ioredis";

export interface SessionKv {
  /** Increments a counter that expires `ttlMs` after its first increment; returns the new value. */
  incr(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Values for several keys, null where missing. */
  mget(keys: string[]): Promise<(string | null)[]>;
}

export class MemoryKv implements SessionKv {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();
  private ops = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  async incr(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key);
    const value = (entry ? Number(entry.value) : 0) + 1;
    this.data.set(key, { value: String(value), expiresAt: entry?.expiresAt ?? this.clock() + ttlMs });
    this.prune();
    return value;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.clock() + ttlMs });
    this.prune();
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k)?.value ?? null);
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Drops expired entries now and then so the map cannot grow without bound. */
  private prune(): void {
    if (++this.ops % 1000 !== 0) return;
    const now = this.clock();
    for (const [k, v] of this.data) if (v.expiresAt <= now) this.data.delete(k);
  }
}

export class RedisKv implements SessionKv {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "chizzy:session:",
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
