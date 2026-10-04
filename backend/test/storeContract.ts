/**
 * Behavioral contract every MatchStore must satisfy.
 *
 * Usage (one line per implementation):
 *   runStoreContract("MemoryStore", () => new MemoryStore());
 *   runStoreContract("RedisStore", () => RedisStore.connect(url, { prefix: `test:${randomUUID()}:` }), { skip: !url });
 *
 * `factory` must return an EMPTY store for every call (Redis: a fresh key
 * prefix), because queue order and stats are asserted exactly. Each store is
 * closed after its test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MatchStore, Room, Session } from "../src/store/MatchStore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(overrides: Partial<Session> = {}): Session {
  return {
    socketId: randomUUID(),
    deviceId: randomUUID(),
    instanceId: "instance-1",
    profile: { name: "A", country: "IN", language: "en", gender: "male", topics: ["general", "music"] },
    preferences: { genderFilter: "all", languageFilter: "any" },
    state: "idle",
    connectedAt: 1,
    ...overrides,
  };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: randomUUID(),
    state: "pending",
    members: [randomUUID(), randomUUID()],
    devices: [randomUUID(), randomUUID()],
    accepted: [false, false],
    createdAt: 1,
    expiresAt: 1000,
    ...overrides,
  };
}

export function runStoreContract(
  name: string,
  factory: () => MatchStore | Promise<MatchStore>,
  opts: { skip?: boolean } = {},
): void {
  describe.skipIf(Boolean(opts.skip))(`MatchStore contract: ${name}`, () => {
    let open: MatchStore[] = [];
    const make = async () => {
      const store = await factory();
      open.push(store);
      return store;
    };
    afterEach(async () => {
      await Promise.all(open.map((s) => s.close()));
      open = [];
    });

    test("ping resolves", async () => {
      const store = await make();
      await expect(store.ping()).resolves.toBeUndefined();
    });

    test("sessions round trip, batch get keeps order, delete", async () => {
      const store = await make();
      const a = session({ state: "waiting", waitingSince: 5 });
      const b = session({ state: "pending", roomId: randomUUID() });
      await store.putSession(a);
      await store.putSession(b);
      expect(await store.getSession(a.socketId)).toEqual(a);
      expect(await store.getSessions([b.socketId, "missing", a.socketId])).toEqual([b, null, a]);
      await store.deleteSession(a.socketId);
      expect(await store.getSession(a.socketId)).toBeNull();
      expect(await store.getSessions([])).toEqual([]);
    });

    test("photos are stored apart from sessions and removed with them", async () => {
      const store = await make();
      const a = session();
      await store.putSession(a);
      expect(await store.getPhoto(a.socketId)).toBeNull();
      await store.setPhoto(a.socketId, "data:image/jpeg;base64,AAAA");
      expect(await store.getPhoto(a.socketId)).toBe("data:image/jpeg;base64,AAAA");
      await store.setPhoto(a.socketId, null);
      expect(await store.getPhoto(a.socketId)).toBeNull();
      await store.setPhoto(a.socketId, "data:image/png;base64,BBBB");
      await store.deleteSession(a.socketId);
      expect(await store.getPhoto(a.socketId)).toBeNull();
    });

    test("values are copied in and out", async () => {
      const store = await make();
      const a = session();
      await store.putSession(a);
      a.state = "active";
      a.profile.topics.push("art");
      const got = (await store.getSession(a.socketId))!;
      expect(got.state).toBe("idle");
      expect(got.profile.topics).toEqual(["general", "music"]);
      got.state = "waiting";
      expect((await store.getSession(a.socketId))!.state).toBe("idle");

      const r = room();
      await store.putRoom(r);
      r.accepted[0] = true;
      expect((await store.getRoom(r.id))!.accepted).toEqual([false, false]);
    });

    test("device binding is cleared only by its own socket", async () => {
      const store = await make();
      const device = randomUUID();
      expect(await store.getDeviceSocket(device)).toBeNull();
      await store.setDeviceSocket(device, "s1");
      await store.setDeviceSocket(device, "s2");
      await store.clearDeviceSocket(device, "s1");
      expect(await store.getDeviceSocket(device)).toBe("s2");
      await store.clearDeviceSocket(device, "s2");
      expect(await store.getDeviceSocket(device)).toBeNull();
    });

    test("waiting queue is ordered by since, re-adding re-scores", async () => {
      const store = await make();
      await store.addWaiting("c", 30);
      await store.addWaiting("a", 10);
      await store.addWaiting("b", 20);
      expect(await store.listWaiting()).toEqual(["a", "b", "c"]);
      await store.addWaiting("a", 40);
      expect(await store.listWaiting()).toEqual(["b", "c", "a"]);
      await store.removeWaiting("c");
      await store.removeWaiting("missing");
      expect(await store.listWaiting()).toEqual(["b", "a"]);
    });

    test("rooms: put, replace, delete, expired pending index", async () => {
      const store = await make();
      const early = room({ expiresAt: 100 });
      const late = room({ expiresAt: 300 });
      const active = room({ expiresAt: 50 });
      await store.putRoom(late);
      await store.putRoom(early);
      await store.putRoom(active);
      expect(await store.listExpiredPendingRooms(1000)).toEqual([active.id, early.id, late.id]);

      active.state = "active";
      active.activeSince = 60;
      await store.putRoom(active);
      expect(await store.getRoom(active.id)).toEqual(active);
      expect(await store.listExpiredPendingRooms(200)).toEqual([early.id]);
      expect(await store.listExpiredPendingRooms(99)).toEqual([]);

      await store.deleteRoom(early.id);
      expect(await store.getRoom(early.id)).toBeNull();
      expect(await store.listExpiredPendingRooms(1000)).toEqual([late.id]);
    });

    test("coins start from the initial balance and add atomically", async () => {
      const store = await make();
      const device = randomUUID();
      expect(await store.getCoins(device)).toBeNull();
      expect(await store.addCoins(device, 5, 100)).toBe(105);
      await Promise.all(Array.from({ length: 20 }, () => store.addCoins(device, 5, 100)));
      expect(await store.getCoins(device)).toBe(205);
    });

    test("friends are symmetric and idempotent", async () => {
      const store = await make();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      expect(await store.areFriends(a, b)).toBe(false);
      await store.addFriends(a, b);
      await store.addFriends(b, a);
      expect(await store.areFriends(b, a)).toBe(true);
      expect(await store.areFriends(a, c)).toBe(false);
    });

    test("blocks are symmetric and retained for retainMs", async () => {
      const store = await make();
      const [a, b] = [randomUUID(), randomUUID()];
      expect(await store.getBlock(a, b)).toBeNull();
      await store.setBlock(a, b, { until: Date.now() - 1, skipCount: 2 }, 150);
      expect(await store.getBlock(b, a)).toEqual({ until: expect.any(Number), skipCount: 2 });
      await sleep(250);
      expect(await store.getBlock(a, b)).toBeNull();
    });

    test("reports count distinct reporters since a time", async () => {
      const store = await make();
      const target = randomUUID();
      const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()];
      const report = (reporterDevice: string, ts: number) =>
        store.addReport({ reporterDevice, reportedDevice: target, roomId: randomUUID(), reason: "spam", ts });
      await report(r1, 100);
      await report(r1, 200);
      await report(r2, 150);
      await report(r3, 50);
      expect(await store.countReporters(target, 0)).toBe(3);
      expect(await store.countReporters(target, 100)).toBe(2);
      expect(await store.countReporters(target, 175)).toBe(1);
      expect(await store.countReporters(randomUUID(), 0)).toBe(0);
    });

    test("bans expire", async () => {
      const store = await make();
      const device = randomUUID();
      expect(await store.getBan(device)).toBeNull();
      const until = Date.now() + 60_000;
      await store.setBan(device, until);
      expect(await store.getBan(device)).toBe(until);
      const short = randomUUID();
      await store.setBan(short, Date.now() + 100);
      await sleep(200);
      expect(await store.getBan(short)).toBeNull();
    });

    test("withLock is mutually exclusive, returns values and releases on error", async () => {
      const store = await make();
      let inside = 0;
      let maxInside = 0;
      let counter = 0;
      const task = () =>
        store.withLock(async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          const read = counter;
          await sleep(2);
          counter = read + 1;
          inside--;
          return read;
        });
      const results = await Promise.all(Array.from({ length: 10 }, task));
      expect(counter).toBe(10);
      expect(maxInside).toBe(1);
      expect([...results].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await expect(store.withLock(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      await expect(store.withLock(async () => "after")).resolves.toBe("after");
    });

    test("instances: heartbeats lapse, sessions are indexed per instance, forget drops it", async () => {
      const store = await make();
      const sorted = (ids: string[]) => [...ids].sort();
      await store.heartbeat("i1", 60_000);
      await store.heartbeat("i2", 100);
      const a = session({ instanceId: "i1" });
      const b = session({ instanceId: "i2" });
      const c = session({ instanceId: "i2" });
      for (const s of [a, b, c]) await store.putSession(s);
      await store.putSession({ ...b, state: "waiting", waitingSince: 3 });
      expect(await store.listDeadInstances()).toEqual([]);
      expect(sorted(await store.listInstanceSessions("i2"))).toEqual(sorted([b.socketId, c.socketId]));
      expect(await store.listInstanceSessions("unknown")).toEqual([]);

      await sleep(200);
      expect(await store.listDeadInstances()).toEqual(["i2"]);
      await store.deleteSession(b.socketId);
      expect(await store.listInstanceSessions("i2")).toEqual([c.socketId]);
      await store.deleteSession(c.socketId);
      await store.forgetInstance("i2");
      expect(await store.listDeadInstances()).toEqual([]);
      expect(await store.listInstanceSessions("i1")).toEqual([a.socketId]);

      // A lapsed instance that beats again is alive again.
      await store.heartbeat("i1", 50);
      await sleep(120);
      expect(await store.listDeadInstances()).toEqual(["i1"]);
      await store.heartbeat("i1", 60_000);
      expect(await store.listDeadInstances()).toEqual([]);
    });

    test("stats count sessions, waiting and rooms by state", async () => {
      const store = await make();
      await store.putSession(session());
      await store.putSession(session());
      await store.addWaiting("w", 1);
      await store.putRoom(room());
      await store.putRoom(room({ state: "active", activeSince: 2 }));
      await store.putRoom(room({ state: "active", activeSince: 3 }));
      expect(await store.stats()).toEqual({ sessions: 2, waiting: 1, pendingRooms: 1, activeRooms: 2 });
    });
  });
}
