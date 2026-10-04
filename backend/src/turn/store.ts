/**
 * Storage for TURN credential issuance: a short per-device credential cache,
 * fixed-window hourly counters (per device, per IP hash) and the device ->
 * IP-hash binding recorded at hello. Memory for one instance, Redis (the
 * server's shared client) for several. Raw IPs are never stored.
 *
 * Redis keys (prefix "chizzy:turn:"):
 *   cache:{deviceId}         JSON IceServer[] (PX = cache TTL)
 *   hit:{key}:{window}       counter for one fixed window (PX = window length)
 *   ip:{deviceId}            IP hash seen at hello (PX = 24 h)
 */
import type Redis from "ioredis";
import type { IceServer } from "../protocol";

export interface TurnStore {
  getCached(deviceId: string): Promise<IceServer[] | null>;
  setCached(deviceId: string, servers: IceServer[], ttlMs: number): Promise<void>;
  /** Increments the counter for the current fixed window of `windowMs` and returns the new count. */
  hit(key: string, windowMs: number): Promise<number>;
  setDeviceIp(deviceId: string, ipHash: string, ttlMs: number): Promise<void>;
  getDeviceIp(deviceId: string): Promise<string | null>;
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/** Drops expired entries now and then so the maps stay bounded by live keys. */
class ExpiringMap<T> {
  private readonly map = new Map<string, Expiring<T>>();
  private writes = 0;

  constructor(private readonly clock: () => number) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.map.set(key, { value, expiresAt: this.clock() + ttlMs });
    if (++this.writes % 1000 === 0) {
      const now = this.clock();
      for (const [k, e] of this.map) if (e.expiresAt <= now) this.map.delete(k);
    }
  }
}

export class MemoryTurnStore implements TurnStore {
  private readonly cache: ExpiringMap<IceServer[]>;
  private readonly hits: ExpiringMap<number>;
  private readonly ips: ExpiringMap<string>;

  constructor(private readonly clock: () => number = Date.now) {
    this.cache = new ExpiringMap(clock);
    this.hits = new ExpiringMap(clock);
    this.ips = new ExpiringMap(clock);
  }

  async getCached(deviceId: string): Promise<IceServer[] | null> {
    const v = this.cache.get(deviceId);
    return v ? structuredClone(v) : null;
  }

  async setCached(deviceId: string, servers: IceServer[], ttlMs: number): Promise<void> {
    if (ttlMs > 0) this.cache.set(deviceId, structuredClone(servers), ttlMs);
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const now = this.clock();
    const windowKey = `${key}:${Math.floor(now / windowMs)}`;
    const count = (this.hits.get(windowKey) ?? 0) + 1;
    this.hits.set(windowKey, count, windowMs - (now % windowMs));
    return count;
  }

  async setDeviceIp(deviceId: string, ipHash: string, ttlMs: number): Promise<void> {
    this.ips.set(deviceId, ipHash, ttlMs);
  }

  async getDeviceIp(deviceId: string): Promise<string | null> {
    return this.ips.get(deviceId) ?? null;
  }
}

export class RedisTurnStore implements TurnStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "chizzy:turn:",
  ) {}

  async getCached(deviceId: string): Promise<IceServer[] | null> {
    const raw = await this.redis.get(`${this.prefix}cache:${deviceId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IceServer[];
    } catch {
      return null;
    }
  }

  async setCached(deviceId: string, servers: IceServer[], ttlMs: number): Promise<void> {
    if (ttlMs > 0) await this.redis.set(`${this.prefix}cache:${deviceId}`, JSON.stringify(servers), "PX", ttlMs);
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const k = `${this.prefix}hit:${key}:${Math.floor(now / windowMs)}`;
    const res = await this.redis.multi().incr(k).pexpire(k, windowMs).exec();
    const count = res?.[0]?.[1];
    if (typeof count !== "number") throw new Error("turn counter failed");
    return count;
  }

  async setDeviceIp(deviceId: string, ipHash: string, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}ip:${deviceId}`, ipHash, "PX", ttlMs);
  }

  async getDeviceIp(deviceId: string): Promise<string | null> {
    return this.redis.get(`${this.prefix}ip:${deviceId}`);
  }
}
