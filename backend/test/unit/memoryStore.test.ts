import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PRUNE_EVERY_WRITES, REPORTS_AGAINST_TTL_MS } from "../../src/store/constants";
import { MemoryStore } from "../../src/store/MemoryStore";
import { runStoreContract } from "../storeContract";

runStoreContract("MemoryStore", () => new MemoryStore());

describe("MemoryStore retention", () => {
  test("a device's reporters are forgotten REPORTS_AGAINST_TTL_MS after its last report, like the Redis index", async () => {
    const store = new MemoryStore();
    const stale = randomUUID();
    const fresh = randomUUID();
    const now = Date.now();
    const report = (reportedDevice: string, ts: number) =>
      store.addReport({ reporterDevice: randomUUID(), reportedDevice, roomId: randomUUID(), reason: "spam", ts });
    await report(stale, now - REPORTS_AGAINST_TTL_MS - 1);
    await report(fresh, now - REPORTS_AGAINST_TTL_MS + 60_000);
    expect(await store.countReporters(stale, 0)).toBe(1);
    // The prune runs every PRUNE_EVERY_WRITES report writes.
    for (let i = 0; i < PRUNE_EVERY_WRITES; i++) await report(randomUUID(), now);
    expect(await store.countReporters(stale, 0)).toBe(0);
    expect(await store.countReporters(fresh, 0)).toBe(1);
  });
});
