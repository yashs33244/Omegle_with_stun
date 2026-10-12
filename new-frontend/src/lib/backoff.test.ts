import { describe, expect, it } from "vitest";
import {
  Backoff,
  RETRY_AFTER_MAX_MS,
  RETRY_MAX_MS,
  RETRY_MAX_PER_MINUTE,
  RETRY_MIN_MS,
  RETRY_WINDOW_MS,
  backoffDelay,
  parseRetryAfter,
} from "./backoff";

/** A deterministic stream of draws in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

describe("backoffDelay", () => {
  it("grows exponentially and never exceeds 30 s", () => {
    const top = () => 0.999_999;
    expect(backoffDelay(0, null, top)).toBe(2_000);
    expect(backoffDelay(1, null, top)).toBe(4_000);
    expect(backoffDelay(2, null, top)).toBe(8_000);
    expect(backoffDelay(3, null, top)).toBe(16_000);
    expect(backoffDelay(4, null, top)).toBe(RETRY_MAX_MS);
    expect(backoffDelay(50, null, top)).toBe(RETRY_MAX_MS);
    expect(backoffDelay(50, null, () => 0)).toBe(RETRY_MIN_MS);
  });

  it("spreads clients that failed at the same moment over the whole window", () => {
    // 1000 clients lose the server at once: their first retries must not land together.
    const random = seeded(7);
    const delays = Array.from({ length: 1000 }, () => backoffDelay(0, null, random));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(RETRY_MIN_MS);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000);
    const perBucket = new Map<number, number>();
    for (const d of delays) perBucket.set(Math.floor(d / 100), (perBucket.get(Math.floor(d / 100)) ?? 0) + 1);
    // 17.5 buckets of 100 ms: no bucket holds more than a small share.
    expect(Math.max(...perBucket.values())).toBeLessThan(120);
    expect(perBucket.size).toBeGreaterThanOrEqual(17);
  });

  it("waits at least Retry-After, plus up to a quarter more, and caps a silly header", () => {
    expect(backoffDelay(0, 10_000, () => 0)).toBe(10_000);
    expect(backoffDelay(0, 10_000, () => 0.999_999)).toBe(12_500);
    expect(backoffDelay(0, 60_000, () => 0)).toBe(60_000);
    expect(backoffDelay(0, 86_400_000, () => 0)).toBe(RETRY_AFTER_MAX_MS);
    // A Retry-After shorter than the backoff does not shorten it.
    expect(backoffDelay(4, 1_000, () => 0.999_999)).toBe(RETRY_MAX_MS);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 9, 12, 10, 0, 0);
    expect(parseRetryAfter("5", now)).toBe(5_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfter(new Date(now - 30_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

describe("Backoff", () => {
  it("allows at most RETRY_MAX_PER_MINUTE attempts in any 60 s, even with the shortest delays", () => {
    let now = 0;
    const backoff = new Backoff(() => now, () => 0);
    backoff.noteAttempt();
    const attempts = [0];
    while (attempts.length < 30) {
      now = backoff.nextAttemptAt();
      attempts.push(now);
      backoff.reset(); // even a server that accepts and drops at once cannot speed it up
    }
    for (let i = 0; i < attempts.length; i++) {
      const inWindow = attempts.filter((t) => t >= attempts[i] && t < attempts[i] + RETRY_WINDOW_MS);
      expect(inWindow.length).toBeLessThanOrEqual(RETRY_MAX_PER_MINUTE);
    }
    // Without the cap 250 ms delays would make 240 attempts a minute.
    expect(attempts[RETRY_MAX_PER_MINUTE]).toBe(RETRY_WINDOW_MS);
  });

  it("counts consecutive failures until reset", () => {
    let now = 0;
    const backoff = new Backoff(() => now, () => 0.999_999);
    now = backoff.nextAttemptAt();
    expect(now).toBe(2_000);
    now = backoff.nextAttemptAt();
    expect(now).toBe(6_000);
    expect(backoff.failures).toBe(2);
    backoff.reset();
    expect(backoff.failures).toBe(0);
    expect(backoff.nextAttemptAt() - now).toBe(2_000);
  });

  it("honours Retry-After", () => {
    const backoff = new Backoff(() => 1_000, () => 0);
    expect(backoff.nextAttemptAt(15_000)).toBe(16_000);
  });
});
