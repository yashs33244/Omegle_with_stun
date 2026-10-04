/**
 * Storage for enforcement metadata: reports, restrictions, appeals, takedowns,
 * the audit log and a few counters. Evidence BYTES never go here (see evidence.ts).
 *
 * The shape is a small document store so the memory and Redis versions stay
 * tiny and behave the same (test/unit/enforcementStore.test.ts runs one
 * contract against both):
 * - documents live in a collection and are indexed there by a numeric score
 *   (usually a timestamp), which drives listing and retention;
 * - secondary indexes are named sorted sets of document ids;
 * - claims, fixed-window counters, small values and per-key counters expire.
 * Values are copied in and out (JSON), like MatchStore.
 */
import type { ChainableCommander, default as Redis } from "ioredis";

export type Collection = "report" | "restriction" | "appeal" | "takedown" | "audit";

export interface RangeOptions {
  /** Inclusive bounds on the score. */
  min?: number;
  max?: number;
  /** Highest score first. */
  reverse?: boolean;
  limit?: number;
}

export interface EnforcementStore {
  /** Inserts or replaces a document and (re)indexes it in its collection by `score`. */
  put(col: Collection, id: string, doc: unknown, score: number): Promise<void>;
  get<T>(col: Collection, id: string): Promise<T | null>;
  /** Same order as `ids`; null for missing ones. */
  getMany<T>(col: Collection, ids: string[]): Promise<(T | null)[]>;
  /** Document ids by collection score. */
  range(col: Collection, opts?: RangeOptions): Promise<string[]>;
  /** Removes the document and its collection entry (not secondary index entries). */
  delete(col: Collection, id: string): Promise<void>;

  addToIndex(index: string, id: string, score: number): Promise<void>;
  removeFromIndex(index: string, id: string): Promise<void>;
  indexRange(index: string, opts?: RangeOptions): Promise<string[]>;

  /** Sets `key` only if absent. True when this call set it. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Fixed-window counter: returns the count including this hit. The window starts at the first hit. */
  hit(key: string, windowMs: number): Promise<number>;
  setValue(key: string, value: unknown, ttlMs: number): Promise<void>;
  getValue<T>(key: string): Promise<T | null>;

  /** Adds `by` to a numeric field and keeps the record for ttlMs from now. */
  incrField(key: string, field: string, by: number, ttlMs: number): Promise<void>;
  /** Sets a numeric field only if it has no value yet; keeps the record for ttlMs from now. */
  setFieldIfAbsent(key: string, field: string, value: number, ttlMs: number): Promise<void>;
  getFields(key: string): Promise<Record<string, number>>;

  ping(): Promise<void>;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function inRange(score: number, opts: RangeOptions): boolean {
  return (opts.min === undefined || score >= opts.min) && (opts.max === undefined || score <= opts.max);
}

/** Sorted ids of a score map, honoring RangeOptions. Ties sort by id for stability. */
function rangeOf(scores: Map<string, number> | undefined, opts: RangeOptions = {}): string[] {
  if (!scores) return [];
  const ids = [...scores]
    .filter(([, s]) => inRange(s, opts))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
  if (opts.reverse) ids.reverse();
  return opts.limit === undefined ? ids : ids.slice(0, opts.limit);
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

export class MemoryEnforcementStore implements EnforcementStore {
  private readonly docs = new Map<string, unknown>();
  private readonly cols = new Map<Collection, Map<string, number>>();
  private readonly indexes = new Map<string, Map<string, number>>();
  private readonly values = new Map<string, Expiring<unknown>>();
  private readonly fields = new Map<string, Expiring<Record<string, number>>>();

  private live<T>(map: Map<string, Expiring<T>>, key: string): Expiring<T> | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  async put(col: Collection, id: string, doc: unknown, score: number): Promise<void> {
    this.docs.set(`${col}:${id}`, copy(doc));
    let scores = this.cols.get(col);
    if (!scores) this.cols.set(col, (scores = new Map()));
    scores.set(id, score);
  }

  async get<T>(col: Collection, id: string): Promise<T | null> {
    const doc = this.docs.get(`${col}:${id}`);
    return doc === undefined ? null : copy(doc as T);
  }

  async getMany<T>(col: Collection, ids: string[]): Promise<(T | null)[]> {
    return Promise.all(ids.map((id) => this.get<T>(col, id)));
  }

  async range(col: Collection, opts?: RangeOptions): Promise<string[]> {
    return rangeOf(this.cols.get(col), opts);
  }

  async delete(col: Collection, id: string): Promise<void> {
    this.docs.delete(`${col}:${id}`);
    this.cols.get(col)?.delete(id);
  }

  async addToIndex(index: string, id: string, score: number): Promise<void> {
    let scores = this.indexes.get(index);
    if (!scores) this.indexes.set(index, (scores = new Map()));
    scores.set(id, score);
  }

  async removeFromIndex(index: string, id: string): Promise<void> {
    const scores = this.indexes.get(index);
    scores?.delete(id);
    if (scores?.size === 0) this.indexes.delete(index);
  }

  async indexRange(index: string, opts?: RangeOptions): Promise<string[]> {
    return rangeOf(this.indexes.get(index), opts);
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (this.live(this.values, `claim:${key}`)) return false;
    this.values.set(`claim:${key}`, { value: 1, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const entry = this.live(this.values, `hit:${key}`);
    if (!entry) {
      this.values.set(`hit:${key}`, { value: 1, expiresAt: Date.now() + windowMs });
      return 1;
    }
    entry.value = (entry.value as number) + 1;
    return entry.value as number;
  }

  async setValue(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.values.set(`val:${key}`, { value: copy(value), expiresAt: Date.now() + ttlMs });
  }

  async getValue<T>(key: string): Promise<T | null> {
    const entry = this.live(this.values, `val:${key}`);
    return entry ? copy(entry.value as T) : null;
  }

  private record(key: string, ttlMs: number): Record<string, number> {
    const entry = this.live(this.fields, key) ?? { value: {}, expiresAt: 0 };
    entry.expiresAt = Date.now() + ttlMs;
    this.fields.set(key, entry);
    return entry.value;
  }

  async incrField(key: string, field: string, by: number, ttlMs: number): Promise<void> {
    const rec = this.record(key, ttlMs);
    rec[field] = (rec[field] ?? 0) + by;
  }

  async setFieldIfAbsent(key: string, field: string, value: number, ttlMs: number): Promise<void> {
    const rec = this.record(key, ttlMs);
    if (rec[field] === undefined) rec[field] = value;
  }

  async getFields(key: string): Promise<Record<string, number>> {
    return { ...(this.live(this.fields, key)?.value ?? {}) };
  }

  async ping(): Promise<void> {}
}

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

/**
 * Redis implementation on the server's shared client (deps.redis). Keys:
 * `<prefix>doc:<col>:<id>` JSON, `<prefix>col:<col>` and `<prefix>ix:<name>`
 * sorted sets, `<prefix>claim|hit|val:<key>` strings, `<prefix>h:<key>` hashes.
 */
export class RedisEnforcementStore implements EnforcementStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "chizzy:enf:",
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
