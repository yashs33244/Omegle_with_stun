/**
 * Storage contract for the session gate: lockouts, rate-limit windows and
 * hourly match caps. Two implementations: MemoryKv (single instance, tests)
 * and RedisKv (several replicas on the server's shared client).
 * test/unit/session.test.ts runs one contract against both.
 */
export interface SessionKv {
  /** Increments a counter that expires `ttlMs` after its first increment; returns the new value. */
  incr(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Values for several keys, null where missing. */
  mget(keys: string[]): Promise<(string | null)[]>;
}
