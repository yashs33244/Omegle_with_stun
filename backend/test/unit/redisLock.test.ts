/**
 * Distributed lock behavior that only matters with several processes
 * sharing one Redis. Skipped unless REDIS_URL is set.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../src/logger";
import { RedisStore, type RedisStoreOptions } from "../../src/store/RedisStore";

const url = process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("RedisStore lock across clients", () => {
  let open: RedisStore[] = [];
  const connect = async (opts: RedisStoreOptions) => {
    const store = await RedisStore.connect(url!, opts);
    open.push(store);
    return store;
  };
  afterEach(async () => {
    await Promise.all(open.map((s) => s.close()));
    open = [];
  });

  test("two clients on one prefix never run critical sections at the same time", async () => {
    const prefix = `test:${randomUUID()}:`;
    const [a, b] = [await connect({ prefix }), await connect({ prefix })];
    let inside = 0;
    let maxInside = 0;
    let counter = 0;
    const task = (store: RedisStore) =>
      store.withLock(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        const read = counter;
        await sleep(3);
        counter = read + 1;
        inside--;
      });
    await Promise.all(Array.from({ length: 20 }, (_, i) => task(i % 2 ? a : b)));
    expect(counter).toBe(20);
    expect(maxInside).toBe(1);
  });

  test("an overrunning critical section is logged and does not delete the next holder's lock", async () => {
    const prefix = `test:${randomUUID()}:`;
    const error = mock(() => {});
    const logger = { error, warn: () => {} } as unknown as Logger;
    const slow = await connect({ prefix, logger, lockTtlMs: 60 });
    const other = await connect({ prefix, lockTtlMs: 5_000 });

    let otherEntered = false;
    let otherInside = false;
    const slowRun = slow.withLock(async () => {
      await sleep(150); // the lease expires after 60 ms
    });
    await sleep(80);
    const otherRun = other.withLock(async () => {
      otherEntered = true;
      otherInside = true;
      await sleep(150);
      otherInside = false;
    });
    await slowRun;
    expect(error).toHaveBeenCalledTimes(1);
    expect(otherEntered).toBe(true);
    expect(otherInside).toBe(true);
    // The slow holder's release must not have freed the other holder's lock.
    const third = await connect({ prefix, lockWaitMs: 30 });
    await expect(third.withLock(async () => "x")).rejects.toThrow("timed out waiting for the match lock");
    await otherRun;
    await expect(third.withLock(async () => "free")).resolves.toBe("free");
  });
});
