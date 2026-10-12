/**
 * Per-socket token buckets, one bucket per event class, plus the per-IP
 * connection rate bucket and the per-session socket cap (see realtime/socket.ts).
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `refillPerSec`. Each event takes one token; an empty bucket rejects.
 */

/**
 * Open sockets one session token may hold on an instance. A browser profile
 * has a few tabs at most; every hello replaces the previous socket's session,
 * so more sockets than this only ever hold slots.
 */
export const MAX_SOCKETS_PER_SESSION = 3;

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

/**
 * Packets one connection may send, before any event handler or per-event
 * bucket sees them (realtime/limitedParser.ts); the connection is closed
 * when a budget runs out. Above the sum of every per-event class below
 * (about 260 burst, 60 per second) and the largest legitimate payloads: a
 * hello with a 150 KB photo, a 20 KB SDP.
 */
export const PACKET_RATE_PER_CONNECTION: BucketSpec = { capacity: 400, refillPerSec: 100 };
export const PACKET_BYTES_PER_CONNECTION: BucketSpec = { capacity: 1024 * 1024, refillPerSec: 128 * 1024 };

/** Event classes, one bucket each. socket.ts maps every event name to one of these. */
export const EVENT_CLASSES = ["hello", "preferences", "control", "signal", "chat", "typing", "report", "telemetry"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

/** Refill rates are per second; the clock is in ms. */
const MS_PER_SECOND = 1_000;

/** Limits per event class. Signal is generous because ICE candidates arrive in bursts. */
export const RATE_LIMITS: Record<EventClass, BucketSpec> = {
  hello: { capacity: 5, refillPerSec: 0.5 },
  preferences: { capacity: 5, refillPerSec: 1 },
  control: { capacity: 10, refillPerSec: 2 },
  signal: { capacity: 200, refillPerSec: 50 },
  chat: { capacity: 10, refillPerSec: 2 },
  typing: { capacity: 10, refillPerSec: 4 },
  report: { capacity: 3, refillPerSec: 1 / 20 },
  /** call:failed, call:telemetry and moderation:signal: a few per call, calls can be seconds apart. */
  telemetry: { capacity: 20, refillPerSec: 1 },
};

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly spec: BucketSpec,
    now: number,
  ) {
    this.tokens = spec.capacity;
    this.last = now;
  }

  /** Takes `cost` tokens (default 1; a byte count for byte budgets); false when the bucket holds fewer. */
  take(now: number, cost = 1): boolean {
    const elapsedSec = Math.max(0, now - this.last) / MS_PER_SECOND;
    this.tokens = Math.min(this.spec.capacity, this.tokens + elapsedSec * this.spec.refillPerSec);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** True once refilled to capacity, when dropping the bucket loses nothing. */
  full(now: number): boolean {
    return this.fill(now) >= 1;
  }

  /** Share of capacity currently available (0 empty, 1 full). */
  fill(now: number): number {
    const elapsedSec = Math.max(0, now - this.last) / MS_PER_SECOND;
    return Math.min(1, (this.tokens + elapsedSec * this.spec.refillPerSec) / this.spec.capacity);
  }
}

/**
 * Entries a bounded map inspects, oldest first, to choose an eviction victim.
 * Keeps the cost of an insert at the cap constant however full the map is.
 */
export const EVICTION_SCAN = 64;

/**
 * Deletes one entry from `map` (kept in least-recently-used order: callers
 * re-insert on access). Among the oldest `scan` entries it drops the one with
 * the highest `score` (Infinity: drop at once, e.g. a refilled bucket), the
 * oldest on ties, so a full map sheds the entries whose loss matters least
 * instead of resetting every limit.
 */
export function evictOne<K, V>(map: Map<K, V>, score: (value: V) => number, scan = EVICTION_SCAN): void {
  let victim: K | undefined;
  let best = -Infinity;
  let seen = 0;
  for (const [key, value] of map) {
    const s = score(value);
    if (victim === undefined || s > best) {
      victim = key;
      best = s;
    }
    if (s === Infinity || ++seen >= scan) break;
  }
  if (victim !== undefined) map.delete(victim);
}

/** All buckets of one socket. Created lazily per class. */
export class SocketRateLimiter {
  private readonly buckets = new Map<EventClass, TokenBucket>();

  constructor(
    private readonly limits: Record<EventClass, BucketSpec> = RATE_LIMITS,
    private readonly clock: () => number = Date.now,
  ) {}

  allow(cls: EventClass): boolean {
    const now = this.clock();
    let bucket = this.buckets.get(cls);
    if (!bucket) {
      bucket = new TokenBucket(this.limits[cls], now);
      this.buckets.set(cls, bucket);
    }
    return bucket.take(now);
  }
}
