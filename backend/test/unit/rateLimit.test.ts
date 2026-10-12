import { describe, expect, test } from "bun:test";
import { IP_BUCKETS_MAX_KEYS } from "../../src/http/constants";
import { IpBuckets } from "../../src/http/public";
import { RATE_LIMITS, SocketRateLimiter, TokenBucket } from "../../src/rateLimit";
import { ConnectionGate } from "../../src/realtime/socket";

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

  test("reports when it has refilled to capacity", () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1 }, 0);
    expect(bucket.full(0)).toBe(true);
    bucket.take(0);
    expect(bucket.full(500)).toBe(false);
    expect(bucket.full(1000)).toBe(true);
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

describe("IpBuckets", () => {
  const spec = { capacity: 2, refillPerSec: 1 / 3600 };

  test("filling the map to its cap does not reset a limited address", () => {
    const buckets = new IpBuckets(spec, () => 0);
    expect([buckets.allow("198.51.100.7"), buckets.allow("198.51.100.7"), buckets.allow("198.51.100.7")]).toEqual([true, true, false]);
    for (let i = 0; i < IP_BUCKETS_MAX_KEYS; i++) buckets.allow(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(buckets.allow("198.51.100.7")).toBe(false);
  });

  test("evicts a refilled bucket before a limited one", () => {
    let now = 0;
    const buckets = new IpBuckets({ capacity: 1, refillPerSec: 1 }, () => now, 2);
    buckets.allow("192.0.2.1");
    now = 5_000; // 192.0.2.1 is full again
    buckets.allow("192.0.2.2");
    buckets.allow("192.0.2.3");
    expect(buckets.allow("192.0.2.2")).toBe(false);
  });

  test("two addresses in one IPv6 /64 share a bucket, another /64 does not", () => {
    const buckets = new IpBuckets(spec, () => 0);
    expect(buckets.allow("2001:db8:0:1::1")).toBe(true);
    expect(buckets.allow("2001:db8:0:1:abcd::2")).toBe(true);
    expect(buckets.allow("2001:db8:0:1::3")).toBe(false);
    expect(buckets.allow("2001:db8:0:2::1")).toBe(true);
  });
});

describe("ConnectionGate", () => {
  const metrics = { rateLimitedTotal: { inc: () => {} } } as unknown as ConstructorParameters<typeof ConnectionGate>[1];

  test("counts connections and connect rate per IPv6 /64", () => {
    const gate = new ConnectionGate({ maxConnectionsPerIp: 1, connectRatePerIp: { capacity: 2, refillPerSec: 0 } }, metrics, () => 0);
    expect(gate.admit("2001:db8:0:1::1")).toBeNull();
    gate.opened("2001:db8:0:1::1");
    expect(gate.admit("2001:db8:0:1::2")).toBe("too_many_connections");
    expect(gate.admit("2001:db8:0:2::1")).toBeNull();
    gate.closed("2001:db8:0:1::1");
    expect(gate.admit("2001:db8:0:1::3")).toBeNull();
    expect(gate.admit("2001:db8:0:1::4")).toBe("rate_limited");
  });
});
