/**
 * Contract both wallet stores must satisfy. Redis runs only with REDIS_URL set
 * (same as the MatchStore contract).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { LEDGER_MAX, MemoryWalletStore, RedisWalletStore, type WalletStore } from "../../src/billing/WalletStore";
import type { BillingOrderRecord, WalletLedgerEntry } from "../../src/protocol";
import { MemoryStore } from "../../src/store/MemoryStore";

const url = process.env.REDIS_URL;

function entry(deviceId: string, delta: number, at: number): WalletLedgerEntry {
  return { id: randomUUID(), deviceId, delta, reason: "earned", ref: "room", at };
}

function order(orderId: string, createdAt: number): BillingOrderRecord {
  return { orderId, deviceId: randomUUID(), packId: "week", coins: 700, amount: 9900, currency: "INR", status: "created", paymentId: null, createdAt, paidAt: null };
}

function runContract(name: string, make: () => Promise<WalletStore>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip ?? false)(name, () => {
    test("balance goes through the match store coins", async () => {
      const store = await make();
      const d = randomUUID();
      expect(await store.getBalance(d)).toBeNull();
      expect(await store.addBalance(d, 5, 100)).toBe(105);
      expect(await store.addBalance(d, -105, 100)).toBe(0);
      expect(await store.getBalance(d)).toBe(0);
    });

    test("ledger is newest first and capped", async () => {
      const store = await make();
      const d = randomUUID();
      for (let i = 0; i < LEDGER_MAX + 5; i++) await store.appendLedger(entry(d, i, i));
      const all = await store.listLedger(d, LEDGER_MAX + 50);
      expect(all).toHaveLength(LEDGER_MAX);
      expect(all[0]!.delta).toBe(LEDGER_MAX + 4);
      expect((await store.listLedger(d, 2)).map((e) => e.delta)).toEqual([LEDGER_MAX + 4, LEDGER_MAX + 3]);
      expect(await store.listLedger(randomUUID(), 10)).toEqual([]);
    });

    test("unlocks are per feature and listed raw (expiry is the service's job)", async () => {
      const store = await make();
      const d = randomUUID();
      expect(await store.getUnlock(d, "gender_filter")).toBeNull();
      await store.setUnlock(d, "gender_filter", 123);
      expect(await store.getUnlock(d, "gender_filter")).toBe(123);
      await store.setUnlock(d, "gender_filter", 456);
      expect(await store.listUnlocks(d)).toEqual({ gender_filter: 456 });
      expect(await store.listUnlocks(randomUUID())).toEqual({});
    });

    test("claimOnce is first-come only", async () => {
      const store = await make();
      const key = `payment:${randomUUID()}`;
      expect(await store.claimOnce(key, 60_000)).toBe(true);
      expect(await store.claimOnce(key, 60_000)).toBe(false);
      expect(await store.claimOnce(`${key}:other`, 60_000)).toBe(true);
    });

    test("orders are stored by id and listed newest first", async () => {
      const store = await make();
      const a = order(`order_${randomUUID()}`, 1000);
      const b = order(`order_${randomUUID()}`, 2000);
      await store.putOrder(a);
      await store.putOrder(b);
      expect(await store.getOrder(a.orderId)).toEqual(a);
      expect(await store.getOrder("order_nope")).toBeNull();
      const paid = { ...a, status: "paid" as const, paymentId: "pay_1", paidAt: 3000 };
      await store.putOrder(paid);
      expect(await store.getOrder(a.orderId)).toEqual(paid);
      const listed = await store.listOrders(10);
      expect(listed.slice(0, 2).map((o) => o.orderId)).toEqual([b.orderId, a.orderId]);
    });
  });
}

runContract("MemoryWalletStore", async () => new MemoryWalletStore(new MemoryStore()));

const clients: Redis[] = [];
afterAll(async () => {
  for (const c of clients) await c.quit();
});
runContract(
  "RedisWalletStore",
  async () => {
    const redis = new Redis(url!, { maxRetriesPerRequest: 2 });
    clients.push(redis);
    return new RedisWalletStore(new MemoryStore(), redis, `test:${randomUUID()}:wallet:`);
  },
  { skip: !url },
);
