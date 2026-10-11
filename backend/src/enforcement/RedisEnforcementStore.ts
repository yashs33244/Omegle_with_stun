/**
 * EnforcementStore on the server's shared Redis client (deps.redis). Keys:
 *   <prefix>doc:<col>:<id>   JSON document
 *   <prefix>col:<col>        sorted set id -> score
 *   <prefix>ix:<name>        sorted set id -> score (secondary index)
 *   <prefix>claim|hit|val:<key>  strings with a TTL
 *   <prefix>h:<key>          hash of numeric fields with a TTL
 */
import type { ChainableCommander, default as Redis } from "ioredis";
import { ENFORCEMENT_KEY_PREFIX } from "./constants";
import type { Collection, EnforcementStore, RangeOptions } from "./EnforcementStore";

/** Runs a MULTI and throws the first command error (exec() reports them per command). */
async function run(multi: ChainableCommander): Promise<unknown[]> {
  const res = await multi.exec();
  if (!res) throw new Error("redis transaction aborted");
  return res.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

/** Redis bounds for RangeOptions (inclusive). */
function bounds(opts: RangeOptions): [string, string] {
  return [opts.min === undefined ? "-inf" : String(opts.min), opts.max === undefined ? "+inf" : String(opts.max)];
}

export class RedisEnforcementStore implements EnforcementStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = ENFORCEMENT_KEY_PREFIX,
  ) {}

  private doc(col: Collection, id: string): string {
    return `${this.prefix}doc:${col}:${id}`;
  }

  private async zrange(key: string, opts: RangeOptions = {}): Promise<string[]> {
    const [min, max] = bounds(opts);
    if (opts.limit === undefined) {
      return opts.reverse ? this.redis.zrevrangebyscore(key, max, min) : this.redis.zrangebyscore(key, min, max);
    }
    return opts.reverse
      ? this.redis.zrevrangebyscore(key, max, min, "LIMIT", 0, opts.limit)
      : this.redis.zrangebyscore(key, min, max, "LIMIT", 0, opts.limit);
  }

  async put(col: Collection, id: string, doc: unknown, score: number): Promise<void> {
    await run(
      this.redis
        .multi()
        .set(this.doc(col, id), JSON.stringify(doc))
        .zadd(`${this.prefix}col:${col}`, score, id),
    );
  }

  async get<T>(col: Collection, id: string): Promise<T | null> {
    const raw = await this.redis.get(this.doc(col, id));
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async getMany<T>(col: Collection, ids: string[]): Promise<(T | null)[]> {
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.doc(col, id)));
    return raws.map((raw) => (raw === null ? null : (JSON.parse(raw) as T)));
  }

  range(col: Collection, opts?: RangeOptions): Promise<string[]> {
    return this.zrange(`${this.prefix}col:${col}`, opts);
  }

  async delete(col: Collection, id: string): Promise<void> {
    await run(this.redis.multi().del(this.doc(col, id)).zrem(`${this.prefix}col:${col}`, id));
  }

  async addToIndex(index: string, id: string, score: number): Promise<void> {
    await this.redis.zadd(`${this.prefix}ix:${index}`, score, id);
  }

  async removeFromIndex(index: string, id: string): Promise<void> {
    await this.redis.zrem(`${this.prefix}ix:${index}`, id);
  }

  indexRange(index: string, opts?: RangeOptions): Promise<string[]> {
    return this.zrange(`${this.prefix}ix:${index}`, opts);
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}claim:${key}`, "1", "PX", ttlMs, "NX")) === "OK";
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const k = `${this.prefix}hit:${key}`;
    const [count] = await run(this.redis.multi().incr(k).pexpire(k, windowMs, "NX"));
    return Number(count);
  }

  async setValue(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}val:${key}`, JSON.stringify(value), "PX", ttlMs);
  }

  async getValue<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(`${this.prefix}val:${key}`);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async incrField(key: string, field: string, by: number, ttlMs: number): Promise<void> {
    const k = `${this.prefix}h:${key}`;
    await run(this.redis.multi().hincrbyfloat(k, field, by).pexpire(k, ttlMs));
  }

  async setFieldIfAbsent(key: string, field: string, value: number, ttlMs: number): Promise<void> {
    const k = `${this.prefix}h:${key}`;
    await run(this.redis.multi().hsetnx(k, field, String(value)).pexpire(k, ttlMs));
  }

  async getFields(key: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(`${this.prefix}h:${key}`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
    return out;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}
