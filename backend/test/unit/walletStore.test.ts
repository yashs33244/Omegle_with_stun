/**
 * Contract both wallet stores must satisfy. Redis runs only with REDIS_URL set
 * (same as the MatchStore contract).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { LEDGER_MAX, MemoryWalletStore, ORDERS_MAX, RedisWalletStore, UNPAID_ORDER_TTL_MS, type WalletStore } from "../../src/billing/WalletStore";
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

    test("claimOnce is first-come only until the claim is released", async () => {
      const store = await make();
      const key = `payment:${randomUUID()}`;
      expect(await store.claimOnce(key)).toBe(true);
      expect(await store.claimOnce(key)).toBe(false);
      expect(await store.claimOnce(`${key}:other`)).toBe(true);
      await store.releaseClaim(key);
      expect(await store.claimOnce(key)).toBe(true);
    });

    test("extendUnlock is atomic: concurrent extends add up from max(now, current)", async () => {
      const store = await make();
      const d = randomUUID();
      const now = 1_000_000;
      expect(await store.extendUnlock(d, "gender_filter", 100, now)).toBe(now + 100);
      // Expired unlock: the extension starts from now, not from the stale expiry.
      expect(await store.extendUnlock(d, "gender_filter", 50, now + 500)).toBe(now + 550);
      const results = await Promise.all([
        store.extendUnlock(d, "gender_filter", 1000, now + 500),
        store.extendUnlock(d, "gender_filter", 2000, now + 500),
      ]);
      expect(Math.max(...results)).toBe(now + 550 + 3000);
      expect(await store.getUnlock(d, "gender_filter")).toBe(now + 550 + 3000);
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

describe("MemoryWalletStore orders", () => {
  test("an unpaid order is gone after UNPAID_ORDER_TTL_MS; a paid one stays", async () => {
    let now = 1_000_000;
    const store = new MemoryWalletStore(new MemoryStore(), () => now);
    const unpaid = order(`order_${randomUUID()}`, now);
    const paid = { ...order(`order_${randomUUID()}`, now), status: "paid" as const, paymentId: "pay_1", paidAt: now };
    await store.putOrder(unpaid);
    await store.putOrder(paid);
    now += UNPAID_ORDER_TTL_MS - 1;
    expect(await store.getOrder(unpaid.orderId)).toEqual(unpaid);
    now += 1;
    expect(await store.getOrder(unpaid.orderId)).toBeNull();
    expect((await store.listOrders(10)).map((o) => o.orderId)).toEqual([paid.orderId]);
    now += 400 * 24 * 60 * 60_000;
    expect(await store.getOrder(paid.orderId)).toEqual(paid);
  });

  test("past ORDERS_MAX the oldest unpaid orders are evicted first; paid ones never are", async () => {
    const store = new MemoryWalletStore(new MemoryStore(), () => 5_000);
    const paid = { ...order(`order_${randomUUID()}`, 1), status: "paid" as const, paymentId: "pay_1", paidAt: 2 };
    await store.putOrder(paid);
    const first = order(`order_${randomUUID()}`, 2);
    await store.putOrder(first);
    for (let i = 0; i < ORDERS_MAX; i++) await store.putOrder(order(`order_${randomUUID()}`, 10 + i));
    expect(await store.getOrder(first.orderId)).toBeNull();
    expect(await store.getOrder(paid.orderId)).toEqual(paid);
    expect(await store.listOrders(ORDERS_MAX + 10)).toHaveLength(ORDERS_MAX);
  });
});

const clients: Redis[] = [];
afterAll(async () => {
  for (const c of clients) await c.quit();
});
function redisStore() {
  const redis = new Redis(url!, { maxRetriesPerRequest: 2 });
  clients.push(redis);
  const prefix = `test:${randomUUID()}:wallet:`;
  return { redis, prefix, store: new RedisWalletStore(new MemoryStore(), redis, prefix) };
}
runContract("RedisWalletStore", async () => redisStore().store, { skip: !url });

describe.skipIf(!url)("RedisWalletStore orders", () => {
  test("an unpaid order carries the TTL; marking it paid removes it", async () => {
    const { redis, prefix, store } = redisStore();
    const o = order(`order_${randomUUID()}`, 1000);
    await store.putOrder(o);
    const ttl = await redis.pttl(`${prefix}order:${o.orderId}`);
    expect(ttl).toBeGreaterThan(UNPAID_ORDER_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(UNPAID_ORDER_TTL_MS);
    await store.putOrder({ ...o, status: "paid", paymentId: "pay_1", paidAt: 2000 });
    expect(await redis.pttl(`${prefix}order:${o.orderId}`)).toBe(-1);
  });
});
