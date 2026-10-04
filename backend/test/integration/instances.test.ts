/**
 * Instance bookkeeping with the memory store: dead instances are reaped,
 * sockets that lost their session are told to reconnect, and a graceful
 * close removes the instance. The Redis variant runs in redis.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Session } from "../../src/store/MatchStore";
import { MemoryStore } from "../../src/store/MemoryStore";
import { delay, hello, next, prefs, profile, record, sendHello, startServer, type TestServer } from "../helpers";

let ts: TestServer | undefined;
afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** Stores a waiting session owned by `instanceId`, as another server would. */
async function foreignWaiter(store: MemoryStore, instanceId: string): Promise<Session> {
  const now = Date.now();
  const { photo: _photo, ...p } = profile();
  const session: Session = {
    socketId: `ghost-${randomUUID()}`,
    deviceId: randomUUID(),
    instanceId,
    profile: p,
    preferences: prefs(),
    mode: "preview",
    state: "waiting",
    waitingSince: now - 1000,
    connectedAt: now - 1000,
  };
  await store.putSession(session);
  await store.setDeviceSocket(session.deviceId, session.socketId);
  await store.addWaiting(session.socketId, session.waitingSince!);
  return session;
}

describe("instances", () => {
  test("sessions of a dead instance are removed and their partners re-queued", async () => {
    const store = new MemoryStore();
    // Checks for dead instances every 30 ms; a generous TTL keeps this server alive on a busy machine.
    ts = await startServer({ heartbeatIntervalMs: 30, instanceTtlMs: 5000, matchAcceptTimeoutMs: 3000 }, store);
    await store.heartbeat("ghost-instance", 60_000);
    const ghost = await foreignWaiter(store, "ghost-instance");

    const c = await ts.connect();
    const found = next(c, "match:found");
    await sendHello(c, hello());
    const match = await found;
    const waiting = record(c, "queue:waiting");

    // The ghost instance stops beating: its heartbeat lapses right away.
    await store.heartbeat("ghost-instance", 1);
    expect(await next(c, "match:ended", 2000)).toEqual({ roomId: match.roomId, reason: "partner-unavailable" });
    await delay(30);
    expect(waiting.length).toBe(1);
    expect(await store.getSession(ghost.socketId)).toBeNull();
    expect(await store.getDeviceSocket(ghost.deviceId)).toBeNull();
    expect(await store.listWaiting()).toEqual([c.id!]);
    expect(await store.listDeadInstances()).toEqual([]);
  });

  test("a live instance never reaps itself", async () => {
    const store = new MemoryStore();
    // A 1 ms TTL: our own heartbeat has always lapsed when the reaper looks.
    ts = await startServer({ heartbeatIntervalMs: 30, instanceTtlMs: 1 }, store);
    const c = await ts.connect();
    await sendHello(c, hello());
    await delay(200);
    expect(await store.getSession(c.id!)).not.toBeNull();
  });

  test("a socket whose session vanished is told to reconnect and disconnected", async () => {
    const store = new MemoryStore();
    ts = await startServer({}, store);
    const c = await ts.connect();
    await sendHello(c, hello());
    const shutdown = next(c, "server:shutdown", 2000);
    const disconnected = new Promise<string>((resolve) => c.once("disconnect", resolve));
    // As if another instance reaped this one while its heartbeat had lapsed.
    await store.deleteSession(c.id!);
    await shutdown;
    expect(await disconnected).toBe("io server disconnect");
  });

  test("graceful close forgets the instance", async () => {
    const store = new MemoryStore();
    const server = await startServer({ instanceTtlMs: 50 }, store);
    const c = await server.connect();
    await sendHello(c, hello());
    expect(await store.listInstanceSessions(server.config.instanceId)).toEqual([c.id!]);
    await server.close();
    await delay(100);
    expect(await store.listDeadInstances()).toEqual([]);
    expect(await store.listInstanceSessions(server.config.instanceId)).toEqual([]);
  });
});
