/**
 * Distributed lock behavior that only matters with several processes
 * sharing one Redis. Skipped unless REDIS_URL is set.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { Logger } from "../../src/logger";
import type { Room, Session } from "../../src/store/MatchStore";
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

  test("a critical section longer than the lease keeps the lock by renewing it", async () => {
    const prefix = `test:${randomUUID()}:`;
    const error = mock(() => {});
    const logger = { error, warn: () => {} } as unknown as Logger;
    const slow = await connect({ prefix, logger, lockTtlMs: 200 });
    const other = await connect({ prefix, lockTtlMs: 5_000 });
    const raw = new Redis(url!);
    try {
      let slowInside = false;
      let otherSawSlowInside = false;
      const slowRun = slow.withLock(async () => {
        slowInside = true;
        // Real time on purpose: the lease is a Redis PX expiry (several leases long).
        await sleep(700);
        slowInside = false;
      });
      await sleep(300);
      expect(await raw.pttl(`${prefix}lock:match`)).toBeGreaterThan(0);
      const otherRun = other.withLock(async () => {
        otherSawSlowInside = slowInside;
      });
      await Promise.all([slowRun, otherRun]);
      expect(otherSawSlowInside).toBe(false);
      expect(error).not.toHaveBeenCalled();
    } finally {
      raw.disconnect();
    }
  });

  test("a lease lost mid section is reported and never extended or deleted by its old holder", async () => {
    const prefix = `test:${randomUUID()}:`;
    const error = mock(() => {});
    const logger = { error, warn: () => {} } as unknown as Logger;
    const slow = await connect({ prefix, logger, lockTtlMs: 60 });
    const other = await connect({ prefix, lockTtlMs: 5_000 });
    const third = await connect({ prefix, lockWaitMs: 30 });
    const raw = new Redis(url!);
    try {
      await raw.ping();
      let otherEntered = false;
      let otherInside = false;
      let slowInside = false;
      const slowRun = slow.withLock(async () => {
        slowInside = true;
        // A stall longer than the lease (GC pause, Redis unreachable): simulate
        // it by dropping the lease behind the holder's back.
        await raw.del(`${prefix}lock:match`);
        await sleep(300);
        slowInside = false;
      });
      // The next renewal notices and reports the loss.
      for (let i = 0; i < 100 && error.mock.calls.length === 0; i++) await sleep(5);
      expect(error).toHaveBeenCalledTimes(1);
      expect(slowInside).toBe(true);
      const otherRun = other.withLock(async () => {
        otherEntered = true;
        otherInside = true;
        await sleep(400);
        otherInside = false;
      });
      await slowRun;
      expect(error).toHaveBeenCalledTimes(1);
      expect(otherEntered).toBe(true);
      expect(otherInside).toBe(true);
      // The old holder neither re-extended the lock nor deleted the other holder's.
      await expect(third.withLock(async () => "x")).rejects.toThrow("timed out waiting for the match lock");
      await otherRun;
      await expect(third.withLock(async () => "free")).resolves.toBe("free");
    } finally {
      raw.disconnect();
    }
  });
});

describe.skipIf(!url)("RedisStore keys", () => {
  test("pending rooms carry a safety TTL, active rooms none", async () => {
    const prefix = `test:${randomUUID()}:`;
    const store = await RedisStore.connect(url!, { prefix });
    const raw = new Redis(url!);
    try {
      const room: Room = {
        id: randomUUID(),
        state: "pending",
        members: ["a", "b"],
        devices: ["da", "db"],
        accepted: [false, false],
        createdAt: Date.now(),
        expiresAt: Date.now() + 5_000,
      };
      await store.putRoom(room);
      expect(await raw.pttl(`${prefix}room:${room.id}`)).toBeGreaterThan(5_000);
      await store.putRoom({ ...room, state: "active", activeSince: Date.now() });
      expect(await raw.pttl(`${prefix}room:${room.id}`)).toBe(-1);
    } finally {
      raw.disconnect();
      await store.close();
    }
  });

  test("an id that could glob, join or inflate a key is rejected before it reaches Redis", async () => {
    const prefix = `test:${randomUUID()}:`;
    const store = await RedisStore.connect(url!, { prefix });
    try {
      for (const bad of ["a*", "a:b", "x\ny", "", "y".repeat(129), "ü"]) {
        await expect(store.getSession(bad)).rejects.toThrow("invalid store key part");
        await expect(store.setDeviceSocket(bad, "s")).rejects.toThrow("invalid store key part");
      }
      // Socket.IO ids (base64url), UUIDs and instance names pass.
      await expect(store.getSession("Ab-_09xyzAb-_09xyzAb")).resolves.toBeNull();
      await expect(store.getBlock(randomUUID(), "other-instance.1")).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });

  test("every key family of a churned session is deleted or expires; only instance bookkeeping stays", async () => {
    const prefix = `test:${randomUUID()}:`;
    const store = await RedisStore.connect(url!, { prefix });
    const raw = new Redis(url!);
    const scan = async () => {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await raw.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 1000);
        cursor = next;
        out.push(...keys.map((k) => k.slice(prefix.length)));
      } while (cursor !== "0");
      return out.sort();
    };
    try {
      await store.heartbeat("i1", 60_000);
      const baseline = await scan();
      const sessions: Session[] = Array.from({ length: 1_000 }, () => ({
        socketId: randomUUID(),
        deviceId: randomUUID(),
        instanceId: "i1",
        profile: { name: "A", country: "IN", language: "en", gender: "male", topics: ["general"] },
        preferences: { genderFilter: "all", languageFilter: "any" },
        mode: "preview",
        state: "waiting",
        waitingSince: 1,
        connectedAt: 1,
      }));
      // The same writes the service makes between hello and disconnect.
      const churn = async (a: Session, b: Session) => {
        await Promise.all([
          store.putSession(a),
          store.putSession(b),
          store.setPhoto(a.socketId, "data:image/jpeg;base64,QUJD"),
          store.setDeviceSocket(a.deviceId, a.socketId),
          store.setDeviceSocket(b.deviceId, b.socketId),
          store.addWaiting(a.socketId, 1),
          store.addWaiting(b.socketId, 1),
        ]);
        const room: Room = {
          id: randomUUID(),
          state: "pending",
          members: [a.socketId, b.socketId],
          devices: [a.deviceId, b.deviceId],
          accepted: [false, false],
          createdAt: 1,
          expiresAt: Date.now() + 60_000,
        };
        await store.putRoom(room);
        await store.putRoom({ ...room, state: "active", activeSince: 2 });
        await store.setBlock(a.deviceId, b.deviceId, { until: 1, skipCount: 1 }, 50);
        await store.deleteRoom(room.id);
        for (const s of [a, b]) {
          await store.removeWaiting(s.socketId);
          await store.deleteSession(s.socketId);
          await store.clearDeviceSocket(s.deviceId, s.socketId);
        }
      };
      const CHUNK = 100;
      for (let i = 0; i < sessions.length; i += CHUNK) {
        const pairs: Promise<void>[] = [];
        for (let j = i; j < i + CHUNK; j += 2) pairs.push(churn(sessions[j]!, sessions[j + 1]!));
        await Promise.all(pairs);
      }
      expect(await store.stats()).toEqual({ sessions: 0, waiting: 0, pendingRooms: 0, activeRooms: 0 });
      // Blocks are the one family left, and they carry their retain TTL.
      for (let i = 0; i < 50 && (await scan()).length > baseline.length; i++) await sleep(10);
      expect(await scan()).toEqual(baseline);
      expect(baseline).toEqual(["instance:i1", "instances"]);
    } finally {
      raw.disconnect();
      await store.close();
    }
  }, 20_000);
});
