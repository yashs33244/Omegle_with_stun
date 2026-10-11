/**
 * Storage contract for enforcement metadata: reports, restrictions, appeals,
 * takedowns, the audit log and a few counters. Evidence BYTES never go here
 * (see evidence.ts).
 *
 * Two implementations: MemoryEnforcementStore (single instance, tests) and
 * RedisEnforcementStore (N instances on the server's shared client).
 * test/unit/enforcementStore.test.ts runs one contract against both.
 *
 * The shape is a small document store so both versions stay tiny:
 * - documents live in a collection and are indexed there by a numeric score
 *   (usually a timestamp), which drives listing and retention;
 * - secondary indexes are named sorted sets of document ids;
 * - claims, fixed-window counters, small values and per-key counters expire.
 * Values are copied in and out (JSON), like MatchStore.
 */
import type { COLLECTIONS } from "./constants";

export type Collection = (typeof COLLECTIONS)[number];

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
