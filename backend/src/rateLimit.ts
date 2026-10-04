/**
 * Per-socket token buckets, one bucket per event class.
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `refillPerSec`. Each event takes one token; an empty bucket rejects.
 */

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

export type EventClass = "hello" | "preferences" | "control" | "signal" | "chat" | "typing" | "report" | "telemetry";

/** Limits per event class. Signal is generous because ICE candidates arrive in bursts. */
export const RATE_LIMITS: Record<EventClass, BucketSpec> = {
  hello: { capacity: 5, refillPerSec: 0.5 },
  preferences: { capacity: 5, refillPerSec: 1 },
  control: { capacity: 10, refillPerSec: 2 },
  signal: { capacity: 200, refillPerSec: 50 },
  chat: { capacity: 10, refillPerSec: 2 },
  typing: { capacity: 10, refillPerSec: 4 },
  report: { capacity: 3, refillPerSec: 1 / 20 },
  /** call:failed, call:telemetry and moderation:signal: a few per call. */
  telemetry: { capacity: 10, refillPerSec: 0.5 },
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

  take(now: number): boolean {
    const elapsedSec = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.spec.capacity, this.tokens + elapsedSec * this.spec.refillPerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
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
