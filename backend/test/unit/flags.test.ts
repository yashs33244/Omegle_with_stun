import { describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { FlagsReader, MemoryFlagsStore, RedisFlagsStore, matchingStatus, parseStaffedHours } from "../../src/flags/flags";
import { FLAG_DEFAULTS } from "../../src/protocol";

const flags = (overrides = {}) => ({ ...FLAG_DEFAULTS, ...overrides });
// 2026-10-04T15:30:00Z is 21:00 in Asia/Kolkata (UTC+5:30).
const NINE_PM_IST = Date.UTC(2026, 9, 4, 15, 30);

describe("flags store", () => {
  test("defaults block the UK, the EU + EEA and Australia", async () => {
    const f = await new MemoryFlagsStore().get();
    for (const code of ["GB", "AU", "DE", "FR", "NO", "IS", "LI"]) expect(f.blocked_countries.split(",")).toContain(code);
    expect(f.blocked_countries.split(",")).not.toContain("US");
    expect(f.blocked_countries.split(",")).not.toContain("IN");
  });

  test("set validates and merges over the defaults", async () => {
    const store = new MemoryFlagsStore();
    const f = await store.set({ matching_enabled: false, banner_message: "Maintenance at 11 pm" });
    expect(f.matching_enabled).toBe(false);
    expect(f.banner_message).toBe("Maintenance at 11 pm");
    expect(f.video_max_kbps).toBe(FLAG_DEFAULTS.video_max_kbps);
  });

  test("set rejects invalid values and unknown keys", async () => {
    const store = new MemoryFlagsStore();
    await expect(store.set({ blocked_countries: "gb" })).rejects.toThrow();
    await expect(store.set({ video_max_kbps: 5 })).rejects.toThrow();
    await expect(store.set({ nope: true } as never)).rejects.toThrow();
  });

  test("the reader notifies listeners only when something changed", async () => {
    const reader = new FlagsReader(new MemoryFlagsStore());
    const seen: boolean[] = [];
    reader.onChange((f) => seen.push(f.matching_enabled));
    await reader.refresh();
    await reader.set({ matching_enabled: false });
    await reader.refresh();
    expect(seen).toEqual([false]);
    expect(reader.current().matching_enabled).toBe(false);
  });
});

describe("staffed hours", () => {
  test("parses windows and rejects nonsense", () => {
    expect(parseStaffedHours("20:00-24:00 Asia/Kolkata")).toEqual({ start: 1200, end: 1440, timeZone: "Asia/Kolkata" });
    expect(parseStaffedHours("20:00-24:00 Mars/Olympus")).toBeNull();
    expect(parseStaffedHours("20:00-20:00 Asia/Kolkata")).toBeNull();
    expect(parseStaffedHours("8pm-midnight")).toBeNull();
  });

  test("open inside the window, closed outside with the next opening time", () => {
    const f = flags({ staffed_hours: "20:00-24:00 Asia/Kolkata" });
    expect(matchingStatus(f, NINE_PM_IST)).toEqual({ open: true, reopensAt: null, message: null });
    const sixPm = NINE_PM_IST - 3 * 3600_000;
    const closed = matchingStatus(f, sixPm);
    expect(closed.open).toBe(false);
    expect(closed.reopensAt).toBe(NINE_PM_IST - 3600_000); // 20:00 IST
  });

  test("windows that cross midnight work", () => {
    const f = flags({ staffed_hours: "22:00-02:00 Asia/Kolkata" });
    const oneAm = NINE_PM_IST + 4 * 3600_000;
    expect(matchingStatus(f, oneAm).open).toBe(true);
    expect(matchingStatus(f, NINE_PM_IST).open).toBe(false);
  });

  test("the kill switch closes matching regardless of hours", () => {
    const status = matchingStatus(flags({ matching_enabled: false, banner_message: "Back soon" }), NINE_PM_IST);
    expect(status).toEqual({ open: false, reopensAt: null, message: "Back soon" });
  });

  test("the reader computes a closed status once per minute, not once per call", async () => {
    const reader = new FlagsReader(new MemoryFlagsStore());
    await reader.set({ staffed_hours: "20:00-24:00 Asia/Kolkata" });
    const sixPm = NINE_PM_IST - 3 * 3600_000;
    const first = reader.status(sixPm);
    expect(first.open).toBe(false);
    // Same minute: the memoized answer comes back; a background refresh that
    // changed nothing must not throw it away.
    await reader.refresh();
    expect(reader.status(sixPm + 59_000)).toBe(first);
    // Next minute or a changed flag set: recomputed.
    expect(reader.status(sixPm + 60_000)).not.toBe(first);
    await reader.set({ staffed_hours: "" });
    expect(reader.status(sixPm)).toEqual({ open: true, reopensAt: null, message: null });
  });

  test("a closed status costs well under a millisecond once the formatter is cached", () => {
    const f = flags({ staffed_hours: "03:00-03:01 Asia/Kolkata" });
    matchingStatus(f, NINE_PM_IST); // warms the per-time-zone formatter
    const started = performance.now();
    for (let i = 0; i < 20; i++) matchingStatus(f, NINE_PM_IST + i);
    // Before the formatter cache each call built up to 1 440 Intl.DateTimeFormat
    // instances and took about 60 ms under Node.
    expect((performance.now() - started) / 20).toBeLessThan(20);
  });
});

describe.skipIf(!process.env.REDIS_URL)("RedisFlagsStore", () => {
  test("round-trips values through a Redis hash", async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    const key = `chizzy:test:flags:${crypto.randomUUID()}`;
    try {
      const store = new RedisFlagsStore(redis, key);
      expect((await store.get()).turn_enabled).toBe(true);
      const f = await store.set({ turn_enabled: false, relay_video_max_kbps: 300 });
      expect(f.turn_enabled).toBe(false);
      expect((await new RedisFlagsStore(redis, key).get()).relay_video_max_kbps).toBe(300);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });
});
