/**
 * Matchmaking and call lifecycle over real sockets (memory store, short timers).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  activePair,
  arrives,
  hello,
  matchedPair,
  next,
  prefs,
  profile,
  sendHello,
  startServer,
  type TestServer,
} from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

describe("hello and matching", () => {
  test("hello acks with coins and ICE servers, then queue:waiting", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const order: string[] = [];
    c.on("queue:waiting", () => order.push("queue:waiting"));
    const ack = await sendHello(c, hello());
    order.push("ack");
    expect(ack).toEqual({ ok: true, coins: 100, iceServers: [{ urls: ts.config.stunUrls }] });
    await next(c, "queue:waiting").catch(() => undefined);
    expect(order[0]).toBe("ack");
  });

  test("two compatible users match; partner sees no gender; exactly one initiator", async () => {
    ts = await startServer();
    const a = hello({ profile: profile({ name: "Alice", gender: "female", photo: "data:image/jpeg;base64,QUJD" }) });
    const b = hello({ profile: profile({ name: "Bob", gender: "male" }) });
    const ca = await ts.connect();
    const cb = await ts.connect();
    const foundA = next(ca, "match:found");
    const foundB = next(cb, "match:found");
    await sendHello(ca, a);
    await sendHello(cb, b);
    const [fa, fb] = await Promise.all([foundA, foundB]);
    expect(fa.roomId).toBe(fb.roomId);
    expect(fa.partner.name).toBe("Bob");
    expect(fb.partner.name).toBe("Alice");
    expect("gender" in fa.partner).toBe(false);
    expect(fb.partner.photo).toBe("data:image/jpeg;base64,QUJD");
    expect("photo" in fa.partner).toBe(false);
    expect(fa.isFriend).toBe(false);
    expect(fa.expiresAt - fa.serverNow).toBe(ts.config.matchAcceptTimeoutMs);

    const partnerAccepted = next(cb, "match:partner-accepted");
    ca.emit("match:accept", { roomId: fa.roomId });
    expect(await partnerAccepted).toEqual({ roomId: fa.roomId });

    const startA = next(ca, "call:start");
    const startB = next(cb, "call:start");
    cb.emit("match:accept", { roomId: fa.roomId });
    const [sa, sb] = await Promise.all([startA, startB]);
    expect(sa).toEqual({ roomId: fa.roomId, initiator: true }); // the older waiter
    expect(sb).toEqual({ roomId: fa.roomId, initiator: false });
  });

  test("rtc:signal is relayed unchanged to the partner", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const offer = { roomId, description: { type: "offer" as const, sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" } };
    const gotB = next(cb, "rtc:signal");
    ca.emit("rtc:signal", offer);
    expect(await gotB).toEqual(offer);

    const candidate = { roomId, candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 } };
    const gotA = next(ca, "rtc:signal");
    cb.emit("rtc:signal", candidate);
    expect(await gotA).toEqual(candidate);
  });

  test("rtc:signal is not relayed while the room is still pending", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await matchedPair(ts);
    const got = arrives(cb, "rtc:signal");
    ca.emit("rtc:signal", { roomId, candidate: { candidate: "c" } });
    expect(await got).toBe(false);
  });

  test("a non-member cannot inject signals, chat or accepts into another room", async () => {
    // Long accept window: the test waits 300 ms between the two accepts.
    ts = await startServer({ matchAcceptTimeoutMs: 5000 });
    const pending = await matchedPair(ts);
    const intruder = await ts.connect();
    await sendHello(intruder, hello({ profile: profile({ topics: ["books"] }) })); // incompatible, stays waiting

    // Accepting someone else's room must not count as their accept.
    intruder.emit("match:accept", { roomId: pending.roomId });
    const partnerAccepted = next(pending.cb, "match:partner-accepted");
    const callStart = arrives(pending.ca, "call:start", 300);
    pending.ca.emit("match:accept", { roomId: pending.roomId });
    await partnerAccepted;
    expect(await callStart).toBe(false);

    const startA = next(pending.ca, "call:start");
    pending.cb.emit("match:accept", { roomId: pending.roomId });
    await startA;

    const signalLeak = arrives(pending.ca, "rtc:signal");
    const chatLeak = arrives(pending.ca, "chat:message");
    intruder.emit("rtc:signal", { roomId: pending.roomId, candidate: { candidate: "c" } });
    const ack = await intruder.timeout(1000).emitWithAck("chat:send", { roomId: pending.roomId, text: "hi" });
    expect(ack).toEqual({ ok: false, error: "not_in_room" });
    intruder.emit("chat:typing", { roomId: pending.roomId, typing: true });
    expect(await signalLeak).toBe(false);
    expect(await chatLeak).toBe(false);
  });

  test("gender filters are mutual", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const b = await ts.connect();
    const c = await ts.connect();
    const aFound = next(a, "match:found", 1500);
    const bFound = arrives(b, "match:found", 400);
    await sendHello(a, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    await sendHello(b, hello({ profile: profile({ gender: "male" }) }));
    expect(await bFound).toBe(false);
    await sendHello(c, hello({ profile: profile({ gender: "female", name: "Carol" }) }));
    expect((await aFound).partner.name).toBe("Carol");
  });

  test("unspecified gender only meets partners whose filter is all", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const b = await ts.connect();
    const found = arrives(a, "match:found", 400);
    await sendHello(a, hello({ profile: profile({ gender: "unspecified" }) }));
    await sendHello(b, hello({ profile: profile({ gender: "female" }), preferences: prefs({ genderFilter: "male" }) }));
    expect(await found).toBe(false);
  });

  test("language filters are mutual", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const b = await ts.connect();
    const c = await ts.connect();
    const aFound = next(a, "match:found", 1500);
    const bFound = arrives(b, "match:found", 400);
    await sendHello(a, hello({ profile: profile({ language: "en" }), preferences: prefs({ languageFilter: "hi" }) }));
    await sendHello(b, hello({ profile: profile({ language: "fr" }) }));
    expect(await bFound).toBe(false);
    await sendHello(c, hello({ profile: profile({ language: "hi", name: "Hema" }) }));
    expect((await aFound).partner.name).toBe("Hema");
  });

  test("session:preferences takes effect on the next match pass", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const b = await ts.connect();
    await sendHello(a, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    await sendHello(b, hello({ profile: profile({ gender: "male" }) }));
    expect(await arrives(a, "match:found", 200)).toBe(false);
    const found = next(a, "match:found");
    const ack = await a.timeout(1000).emitWithAck("session:preferences", { preferences: prefs() });
    expect(ack).toEqual({ ok: true });
    await found;
  });

  test("preferences before hello are rejected", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const ack = await a.timeout(1000).emitWithAck("session:preferences", { preferences: prefs() });
    expect(ack).toMatchObject({ ok: false, error: "bad_state" });
  });
});

describe("ending a match", () => {
  test("decline ends the match for both, re-queues both and blocks the pair", async () => {
    ts = await startServer();
    const { ca, cb, roomId, a, b } = await matchedPair(ts);
    const endA = next(ca, "match:ended");
    const endB = next(cb, "match:ended");
    const waitA = next(ca, "queue:waiting");
    const waitB = next(cb, "queue:waiting");
    const rematch = arrives(ca, "match:found", 400);
    ca.emit("match:decline", { roomId });
    expect(await endA).toEqual({ roomId, reason: "declined" });
    expect(await endB).toEqual({ roomId, reason: "partner-declined" });
    await Promise.all([waitA, waitB]);
    expect(await rematch).toBe(false);
    const block = await ts.store.getBlock(a.deviceId, b.deviceId);
    expect(block!.until - Date.now()).toBeGreaterThan(25_000);
    expect(block!.skipCount).toBe(0);

    // A third user is matched with one of them instead.
    const c = await ts.connect();
    const found = next(c, "match:found");
    await sendHello(c, hello());
    await found;
  });

  test("nobody accepting times out both, re-queues and blocks", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await matchedPair(ts);
    const endA = next(ca, "match:ended", 2000);
    const endB = next(cb, "match:ended", 2000);
    ca.emit("match:accept", { roomId }); // one side accepting is not enough
    expect(await endA).toEqual({ roomId, reason: "timeout" });
    expect(await endB).toEqual({ roomId, reason: "timeout" });
    expect(await arrives(ca, "match:found", 300)).toBe(false);
    // A late accept for the dead room does nothing.
    ca.emit("match:accept", { roomId });
    expect(await arrives(ca, "call:start", 200)).toBe(false);
  });

  test("an accept within the grace window after expiresAt still starts the call", async () => {
    ts = await startServer({ matchAcceptTimeoutMs: 150, matchAcceptGraceMs: 400 });
    const { ca, cb, roomId } = await matchedPair(ts);
    ca.emit("match:accept", { roomId });
    await new Promise((r) => setTimeout(r, 250)); // past expiresAt, inside the grace
    const start = next(cb, "call:start");
    cb.emit("match:accept", { roomId });
    expect((await start).roomId).toBe(roomId);
  });

  test("an accept after the grace window is answered with not_in_room, not dropped", async () => {
    // No sweeps: the expired room stays pending so the late accept reaches it.
    ts = await startServer({ matchAcceptTimeoutMs: 100, matchAcceptGraceMs: 50, sweepIntervalMs: 60_000 });
    const { ca, roomId } = await matchedPair(ts);
    await new Promise((r) => setTimeout(r, 250));
    const error = next(ca, "server:error");
    const start = arrives(ca, "call:start", 200);
    ca.emit("match:accept", { roomId });
    expect(await error).toEqual({ code: "not_in_room", message: "the match expired" });
    expect(await start).toBe(false);
  });

  test("skip during a call ends it, re-queues both and escalates the block", async () => {
    ts = await startServer();
    const { ca, cb, roomId, a, b } = await activePair(ts);
    const endA = next(ca, "match:ended");
    const endB = next(cb, "match:ended");
    const waitB = next(cb, "queue:waiting");
    ca.emit("call:skip");
    expect(await endA).toEqual({ roomId, reason: "skipped" });
    expect(await endB).toEqual({ roomId, reason: "partner-skipped" });
    await waitB;
    const block = await ts.store.getBlock(a.deviceId, b.deviceId);
    expect(block!.skipCount).toBe(1);
    expect(block!.until - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(await arrives(ca, "match:found", 300)).toBe(false);
  });

  test("skipping the same device again after the block lapses doubles the block", async () => {
    ts = await startServer();
    const { ca, cb, a, b } = await activePair(ts);
    ca.emit("call:skip");
    await next(cb, "match:ended");
    // Let the first block lapse but keep its record (as the store would for 24 h).
    const first = await ts.store.getBlock(a.deviceId, b.deviceId);
    const rematchA = next(ca, "match:found");
    await ts.store.setBlock(a.deviceId, b.deviceId, { ...first!, until: Date.now() - 1 }, 60_000);
    const { roomId } = await rematchA;
    const endB = next(cb, "match:ended");
    ca.emit("call:skip");
    expect(await endB).toEqual({ roomId, reason: "partner-skipped" });
    const second = await ts.store.getBlock(a.deviceId, b.deviceId);
    expect(second!.skipCount).toBe(2);
    expect(second!.until - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  test("a waiting pair is matched soon after its block lapses, without a recheck", async () => {
    // The only recheck runs on the first sweep, before anyone is waiting.
    ts = await startServer({ recheckIntervalMs: 60_000 });
    const a = hello();
    const b = hello();
    const lapse = Date.now() + 400;
    await ts.store.setBlock(a.deviceId, b.deviceId, { until: lapse, skipCount: 1 }, 60_000);
    const ca = await ts.connect();
    const cb = await ts.connect();
    const found = next(ca, "match:found", 2000);
    await sendHello(ca, a);
    await sendHello(cb, b);
    await found;
    expect(Date.now()).toBeGreaterThanOrEqual(lapse);
  });

  test("the recheck reaches every waiter of a long queue in bounded slices", async () => {
    // One session per recheck: 40 unmatchable waiters plus the pair below.
    ts = await startServer({ recheckPairBudget: 1, recheckIntervalMs: 20 });
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      // Men who only want women: they match neither each other nor the pair.
      const { photo: _photo, ...p } = profile({ gender: "male" });
      const socketId = `ghost-${i}`;
      await ts.store.putSession({
        socketId,
        deviceId: randomUUID(),
        // Another instance's: the server removes its own sessions that have no socket.
        instanceId: "other-instance",
        profile: p,
        preferences: prefs({ genderFilter: "female" }),
        state: "waiting",
        waitingSince: now - 1000 + i,
        connectedAt: now,
      });
      await ts.store.addWaiting(socketId, now - 1000 + i);
    }
    const a = hello();
    const b = hello();
    await ts.store.setBlock(a.deviceId, b.deviceId, { until: now + 60_000, skipCount: 1 }, 60_000);
    const ca = await ts.connect();
    const cb = await ts.connect();
    const found = next(ca, "match:found", 4000);
    await sendHello(ca, a);
    await sendHello(cb, b);
    // The block is lifted behind the server's back, so no lapse is scheduled for it.
    await ts.store.setBlock(a.deviceId, b.deviceId, { until: Date.now() - 1, skipCount: 1 }, 60_000);
    await found;
  });

  test("skip while pending also ends the match", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await matchedPair(ts);
    const endB = next(cb, "match:ended");
    ca.emit("call:skip");
    expect(await endB).toEqual({ roomId, reason: "partner-skipped" });
  });

  test("disconnect notifies the partner and re-queues it", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const end = next(cb, "match:ended");
    const wait = next(cb, "queue:waiting");
    ca.disconnect();
    expect(await end).toEqual({ roomId, reason: "partner-left" });
    await wait;
    // Under the lock: events can reach the client before the handler that sent them finishes.
    const stats = await ts.store.withLock(() => ts!.store.stats());
    expect(stats).toEqual({ sessions: 1, waiting: 1, pendingRooms: 0, activeRooms: 0 });

    const c = await ts.connect();
    const found = next(cb, "match:found");
    await sendHello(c, hello());
    await found;
  });

  test("a new socket with the same deviceId replaces the old session", async () => {
    ts = await startServer();
    const { ca, cb, roomId, a } = await matchedPair(ts);
    const replaced = next(ca, "session:replaced");
    const disconnected = new Promise<void>((r) => ca.once("disconnect", () => r()));
    const ended = next(cb, "match:ended");
    const c = await ts.connect();
    const ack = await sendHello(c, hello({ deviceId: a.deviceId }));
    expect(ack.ok).toBe(true);
    await replaced;
    await disconnected;
    expect(await ended).toEqual({ roomId, reason: "partner-unavailable" });
    expect(await ts.store.getDeviceSocket(a.deviceId)).toBe(c.id!);
  });

  test("a repeated hello on the same socket updates the profile without leaving the room", async () => {
    ts = await startServer();
    const { ca, roomId, a } = await activePair(ts);
    const ack = await sendHello(ca, { ...a, profile: profile({ name: "Renamed" }) });
    expect(ack.ok).toBe(true);
    const s = await ts.store.getSession(ca.id!);
    expect(s!.state).toBe("active");
    expect(s!.roomId).toBe(roomId);
    expect(s!.profile.name).toBe("Renamed");
  });

  test("a repeated hello with a different deviceId is rejected", async () => {
    ts = await startServer();
    const c = await ts.connect();
    await sendHello(c, hello());
    const ack = await sendHello(c, hello({ deviceId: randomUUID() }));
    expect(ack).toMatchObject({ ok: false, error: "bad_state" });
  });

  test("queue order is FIFO", async () => {
    ts = await startServer();
    const first = await ts.connect();
    const second = await ts.connect();
    await sendHello(first, hello({ profile: profile({ topics: ["art"], name: "First" }) }));
    await sendHello(second, hello({ profile: profile({ topics: ["art"], name: "Second" }), preferences: prefs({ genderFilter: "female" }) }));
    // second will not match first (first is unspecified); a newcomer matches the oldest compatible waiter.
    const newcomer = await ts.connect();
    const found = next(newcomer, "match:found");
    const firstFound = next(first, "match:found");
    await sendHello(newcomer, hello({ profile: profile({ topics: ["art"], gender: "female" }) }));
    expect((await found).partner.name).toBe("First");
    expect((await firstFound).partner.topics).toEqual(["art"]);
  });
});
