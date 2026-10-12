/**
 * In-process EnforcementStore for a single instance (local dev and tests).
 * Values are JSON-copied in and out so behavior matches the Redis store.
 * Expiring entries (claims, counters, values, field records) are dropped on
 * read once expired and swept every SWEEP_EVERY_WRITES writes, so a long-lived
 * memory store (one lastRoom value per ended room) stays bounded.
 */
import type { Collection, EnforcementStore, RangeOptions } from "./EnforcementStore";

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

/** Expired entries are swept after this many writes to the expiring maps. */
export const SWEEP_EVERY_WRITES = 1_000;

export class MemoryEnforcementStore implements EnforcementStore {
  private readonly docs = new Map<string, unknown>();
  private readonly cols = new Map<Collection, Map<string, number>>();
  private readonly indexes = new Map<string, Map<string, number>>();
  private readonly values = new Map<string, Expiring<unknown>>();
  private readonly fields = new Map<string, Expiring<Record<string, number>>>();

  private writes = 0;

  /** Expiring entries currently held, swept or not (tests check the sweep). */
  get expiringEntries(): number {
    return this.values.size + this.fields.size;
  }

  private live<T>(map: Map<string, Expiring<T>>, key: string): Expiring<T> | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Counts one write to an expiring map and sweeps expired entries every SWEEP_EVERY_WRITES. */
  private wrote(): void {
    if (++this.writes % SWEEP_EVERY_WRITES !== 0) return;
    const now = Date.now();
    for (const map of [this.values, this.fields]) {
      for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
    }
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

  async indexCount(index: string, opts: Pick<RangeOptions, "min" | "max"> = {}): Promise<number> {
    const scores = this.indexes.get(index);
    if (!scores) return 0;
    if (opts.min === undefined && opts.max === undefined) return scores.size;
    let n = 0;
    for (const s of scores.values()) if (inRange(s, opts)) n++;
    return n;
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (this.live(this.values, `claim:${key}`)) return false;
    this.values.set(`claim:${key}`, { value: 1, expiresAt: Date.now() + ttlMs });
    this.wrote();
    return true;
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const entry = this.live(this.values, `hit:${key}`);
    if (!entry) {
      this.values.set(`hit:${key}`, { value: 1, expiresAt: Date.now() + windowMs });
      this.wrote();
      return 1;
    }
    entry.value = (entry.value as number) + 1;
    return entry.value as number;
  }

  async setValue(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.values.set(`val:${key}`, { value: copy(value), expiresAt: Date.now() + ttlMs });
    this.wrote();
  }

  async getValue<T>(key: string): Promise<T | null> {
    const entry = this.live(this.values, `val:${key}`);
    return entry ? copy(entry.value as T) : null;
  }

  private record(key: string, ttlMs: number): Record<string, number> {
    const entry = this.live(this.fields, key) ?? { value: {}, expiresAt: 0 };
    entry.expiresAt = Date.now() + ttlMs;
    this.fields.set(key, entry);
    this.wrote();
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
