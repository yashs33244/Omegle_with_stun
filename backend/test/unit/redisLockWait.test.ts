/**
 * RedisStore.withLock() timing against an in-memory stand-in for the few
 * Redis commands the lock uses, so it runs without a Redis server.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { RedisStore, type RedisStoreOptions } from "../../src/store/RedisStore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Just enough of ioredis for the lock: SET NX, GET and the compare-and-delete script. */
class FakeRedis extends EventEmitter {
  holder: string | null = null;
  /** SET attempts made while someone held the lock. */
  contendedSets = 0;

  async set(_key: string, token: string): Promise<"OK" | null> {
    if (this.holder !== null) {
      this.contendedSets++;
      return null;
    }
    this.holder = token;
    return "OK";
  }

  async get(): Promise<string | null> {
    return this.holder;
  }

  async eval(_script: string, _keys: number, _key: string, token: string): Promise<number> {
    if (this.holder !== token) return 0;
    this.holder = null;
    return 1;
  }
}

function storeOn(redis: FakeRedis, opts: RedisStoreOptions): RedisStore {
  const Ctor = RedisStore as unknown as new (redis: FakeRedis, opts: RedisStoreOptions) => RedisStore;
  return new Ctor(redis, opts);
}

describe("RedisStore.withLock wait budget", () => {
  test("lockWaitMs also bounds the time spent queued behind local callers", async () => {
    const store = storeOn(new FakeRedis(), { lockWaitMs: 200 });
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.withLock(async () => {
          await sleep(300);
          return Date.now() - started;
        }),
      ),
    );
    expect(results[0]!.status).toBe("fulfilled");
    for (const r of results.slice(1)) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(String(r.reason)).toContain("timed out waiting for the match lock");
    }
    // Everyone settled once the first holder finished, not after 5 x 300 ms.
    expect(Date.now() - started).toBeLessThan(700);
  });

  test("a caller that times out in the local queue does not let the next one poll Redis early", async () => {
    const redis = new FakeRedis();
    const store = storeOn(redis, { lockWaitMs: 200 });
    const first = store.withLock(() => sleep(300));
    const second = store.withLock(async () => "second");
    await sleep(150);
    // Its budget (until about 350 ms) outlasts the first holder (300 ms).
    const third = store.withLock(async () => "third");
    await expect(second).rejects.toThrow("timed out waiting for the match lock");
    await first;
    await expect(third).resolves.toBe("third");
    expect(redis.contendedSets).toBe(0);
  });

  test("a reentrant call rejects after lockWaitMs instead of hanging", async () => {
    const store = storeOn(new FakeRedis(), { lockWaitMs: 100 });
    const started = Date.now();
    await expect(store.withLock(() => store.withLock(async () => "inner"))).rejects.toThrow(
      "timed out waiting for the match lock",
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/**
 * The connection dropped after Redis applied SET NX but before the reply
 * arrived: ioredis re-sends the command on reconnect and it now answers null.
 */
class LostReplyRedis extends FakeRedis {
  private lost = false;

  override async set(key: string, token: string): Promise<"OK" | null> {
    const reply = await super.set(key, token);
    if (reply !== "OK" || this.lost) return reply;
    this.lost = true;
    return super.set(key, token);
  }
}

describe("RedisStore.withLock after a re-sent SET", () => {
  test("a lock it already holds counts as acquired instead of waiting out its own lease", async () => {
    const redis = new LostReplyRedis();
    const store = storeOn(redis, { lockWaitMs: 300 });
    const started = Date.now();
    await expect(store.withLock(async () => "ran")).resolves.toBe("ran");
    expect(Date.now() - started).toBeLessThan(100);
    expect(redis.holder).toBeNull();
  });
});
