import { describe, expect, test } from "bun:test";
import { RATE_LIMITS, SocketRateLimiter, TokenBucket } from "../../src/rateLimit";

describe("TokenBucket", () => {
  test("allows a burst up to capacity, then rejects", () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 }, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
  });

  test("refills continuously and never above capacity", () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 2 }, 0);
    bucket.take(0);
    bucket.take(0);
    expect(bucket.take(100)).toBe(false); // 0.2 tokens
    expect(bucket.take(500)).toBe(true); // 1 token back
    expect(bucket.take(10_000)).toBe(true);
    expect(bucket.take(10_000)).toBe(true);
    expect(bucket.take(10_000)).toBe(false); // capped at 2
  });

  test("a clock going backwards does not mint tokens", () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1 }, 1000);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(0)).toBe(false);
  });
});

describe("SocketRateLimiter", () => {
  test("event classes have independent buckets", () => {
    let now = 0;
    const limiter = new SocketRateLimiter(RATE_LIMITS, () => now);
    for (let i = 0; i < RATE_LIMITS.chat.capacity; i++) expect(limiter.allow("chat")).toBe(true);
    expect(limiter.allow("chat")).toBe(false);
    expect(limiter.allow("signal")).toBe(true);
    now += 1000;
    expect(limiter.allow("chat")).toBe(true);
  });
});
