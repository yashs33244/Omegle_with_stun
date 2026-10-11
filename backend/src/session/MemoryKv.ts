/**
 * In-process SessionKv for a single instance (local dev and tests).
 */
import { PRUNE_EVERY_OPS } from "./constants";
import type { SessionKv } from "./SessionKv";

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
    if (++this.ops % PRUNE_EVERY_OPS !== 0) return;
    const now = this.clock();
    for (const [k, v] of this.data) if (v.expiresAt <= now) this.data.delete(k);
  }
}
