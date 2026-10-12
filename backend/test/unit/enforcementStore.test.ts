/**
 * One contract for both enforcement stores. The Redis half runs when REDIS_URL is set.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { EnforcementStore } from "../../src/enforcement/EnforcementStore";
import { MemoryEnforcementStore, SWEEP_EVERY_WRITES } from "../../src/enforcement/MemoryEnforcementStore";
import { RedisEnforcementStore } from "../../src/enforcement/RedisEnforcementStore";
import { delay } from "../helpers";

function contract(name: string, make: () => EnforcementStore) {
  describe(name, () => {
    test("documents round-trip as copies and list by score", async () => {
      const s = make();
      const doc = { a: 1, nested: { b: [1, 2] } };
      await s.put("report", "r1", doc, 30);
      await s.put("report", "r2", { a: 2 }, 10);
      await s.put("report", "r3", { a: 3 }, 20);
      doc.nested.b.push(3);
      expect(await s.get<object>("report", "r1")).toEqual({ a: 1, nested: { b: [1, 2] } });
      const got = await s.get<{ a: number }>("report", "r2");
      got!.a = 99;
      expect(await s.get<object>("report", "r2")).toEqual({ a: 2 });
      expect(await s.get("report", "missing")).toBeNull();
      expect(await s.getMany("report", ["r3", "missing", "r1"])).toEqual([{ a: 3 }, null, { a: 1, nested: { b: [1, 2] } }]);
      expect(await s.getMany("report", [])).toEqual([]);

      expect(await s.range("report")).toEqual(["r2", "r3", "r1"]);
      expect(await s.range("report", { reverse: true })).toEqual(["r1", "r3", "r2"]);
      expect(await s.range("report", { min: 15, max: 30 })).toEqual(["r3", "r1"]);
      expect(await s.range("report", { reverse: true, limit: 2 })).toEqual(["r1", "r3"]);
      expect(await s.range("report", { max: 9 })).toEqual([]);
      // Collections are separate.
      expect(await s.range("audit")).toEqual([]);

      // Re-put moves the score.
      await s.put("report", "r2", { a: 2 }, 40);
      expect(await s.range("report")).toEqual(["r3", "r1", "r2"]);
      await s.delete("report", "r1");
      expect(await s.get<object>("report", "r1")).toBeNull();
      expect(await s.range("report")).toEqual(["r3", "r2"]);
    });

    test("secondary indexes", async () => {
      const s = make();
      const ix = `against:${randomUUID()}`;
      await s.addToIndex(ix, "a", 5);
      await s.addToIndex(ix, "b", 1);
      await s.addToIndex(ix, "c", 9);
      expect(await s.indexRange(ix)).toEqual(["b", "a", "c"]);
      expect(await s.indexRange(ix, { min: 2 })).toEqual(["a", "c"]);
      expect(await s.indexRange(ix, { max: 4 })).toEqual(["b"]);
      expect(await s.indexCount(ix)).toBe(3);
      expect(await s.indexCount(ix, { min: 2 })).toBe(2);
      expect(await s.indexCount(ix, { max: 4 })).toBe(1);
      expect(await s.indexCount(ix, { min: 5, max: 9 })).toBe(2);
      await s.removeFromIndex(ix, "a");
      expect(await s.indexRange(ix)).toEqual(["b", "c"]);
      expect(await s.indexCount(ix)).toBe(2);
      expect(await s.indexRange(`against:${randomUUID()}`)).toEqual([]);
      expect(await s.indexCount(`against:${randomUUID()}`, { max: 4 })).toBe(0);
    });

    test("claims, counters and values expire", async () => {
      const s = make();
      const k = randomUUID();
      expect(await s.claim(k, 80)).toBe(true);
      expect(await s.claim(k, 80)).toBe(false);
      expect(await s.hit(k, 80)).toBe(1);
      expect(await s.hit(k, 80)).toBe(2);
      expect(await s.hit(k, 80)).toBe(3);
      await s.setValue(k, { x: [1] }, 80);
      expect(await s.getValue<object>(k)).toEqual({ x: [1] });
      expect(await s.getValue(randomUUID())).toBeNull();
      await delay(150);
      expect(await s.claim(k, 80)).toBe(true);
      expect(await s.hit(k, 80)).toBe(1);
      expect(await s.getValue(k)).toBeNull();
    });

    test("numeric fields", async () => {
      const s = make();
      const k = `dev:${randomUUID()}`;
      expect(await s.getFields(k)).toEqual({});
      await s.setFieldIfAbsent(k, "firstSeen", 100, 10_000);
      await s.setFieldIfAbsent(k, "firstSeen", 200, 10_000);
      await s.incrField(k, "calls", 1, 10_000);
      await s.incrField(k, "calls", 2, 10_000);
      expect(await s.getFields(k)).toEqual({ firstSeen: 100, calls: 3 });
      await s.incrField(k, "short", 1, 60);
      await delay(120);
      expect(await s.getFields(k)).toEqual({});
    });

    test("ping", async () => {
      await make().ping();
    });
  });
}

contract("MemoryEnforcementStore", () => new MemoryEnforcementStore());

describe("MemoryEnforcementStore eviction", () => {
  test("expired entries that nobody reads again are swept, so the store stays bounded", async () => {
    const s = new MemoryEnforcementStore();
    const ttl = 200;
    for (let i = 0; i < SWEEP_EVERY_WRITES; i++) {
      await s.setValue(`lastroom:${i}`, { i }, ttl);
      await s.claim(`room-report:${i}`, ttl);
      await s.hit(`report-rate:${i}`, ttl);
      await s.incrField(`dev:${i}`, "completedCalls", 1, ttl);
    }
    expect(s.expiringEntries).toBe(4 * SWEEP_EVERY_WRITES);
    await delay(ttl + 20);
    // Each write after the TTLs passed is one step toward the next sweep; the sweep drops everything expired.
    for (let i = 0; i < SWEEP_EVERY_WRITES; i++) await s.setValue("live", { i }, 60_000);
    expect(s.expiringEntries).toBe(1);
    expect(await s.getValue<{ i: number }>("live")).toEqual({ i: SWEEP_EVERY_WRITES - 1 });
  });
});

const url = process.env.REDIS_URL;
const clients: Redis[] = [];
afterAll(async () => {
  for (const c of clients) await c.quit();
});
if (url) {
  contract("RedisEnforcementStore", () => {
    const client = new Redis(url, { maxRetriesPerRequest: 2 });
    clients.push(client);
    return new RedisEnforcementStore(client, `test:${randomUUID()}:enf:`);
  });
} else {
  describe.skip("RedisEnforcementStore (set REDIS_URL)", () => {
    test("skipped", () => {});
  });
}
