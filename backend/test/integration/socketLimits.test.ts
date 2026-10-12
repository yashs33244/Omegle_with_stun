/**
 * Socket-layer limits that are not about matching itself: what one connection
 * or one session can hold or send, and that nothing stays behind when it goes.
 * Each test names the limit it pins; docs/LIMITS.md cites them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { io as ioClient } from "socket.io-client";
import { LIMITS } from "../../src/protocol";
import { MAX_SOCKETS_PER_SESSION, PACKET_RATE_PER_CONNECTION } from "../../src/rateLimit";
import { ACCEPT_TIMEOUT_STRIKES } from "../../src/safety/constants";
import { MINUTE_CAP_MESSAGE } from "../../src/session/constants";
import {
  activePair,
  arrives,
  connectWithSession,
  delay,
  hello,
  matchedPair,
  next,
  postSession,
  prefs,
  profile,
  sendHello,
  sessionBody,
  startServer,
  type Client,
  type TestServer,
} from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

function rawEmit(client: Client, event: string, ...args: unknown[]): void {
  (client.emit as (ev: string, ...a: unknown[]) => void)(event, ...args);
}

async function metricValue(t: TestServer, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = t.server.metrics.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, x]) => (v.labels as Record<string, unknown>)[k] === x))
    .reduce((sum, v) => sum + v.value, 0);
}

/** Resolves when the client is disconnected by the server, or false after `ms`. */
function dropped(client: Client, ms: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), ms);
  client.once("disconnect", () => {
    clearTimeout(timer);
    resolve(true);
  });
  return promise;
}

/** Waits for connect or connect_error; resolves with the error message or "connected". */
function tryConnect(ts: TestServer, auth: Record<string, unknown>): Promise<string> {
  const client: Client = ioClient(ts.url, { transports: ["websocket"], forceNew: true, reconnection: false, auth });
  ts.clients.push(client);
  const { promise, resolve } = Promise.withResolvers<string>();
  client.once("connect", () => resolve("connected"));
  client.once("connect_error", (err) => resolve(err.message));
  return promise;
}

describe("one connection", () => {
  test("a socket that never says hello is disconnected at the hello deadline and leaves nothing behind", async () => {
    // Real timers: the deadline is a server-side setTimeout driven by the config, not a fake clock.
    ts = await startServer({ helloTimeoutMs: 150 });
    const silent = await ts.connect();
    const talker = await ts.connect();
    await sendHello(talker, hello());
    expect(await dropped(silent, 1000)).toBe(true);
    expect(talker.connected).toBe(true);
    expect(await metricValue(ts, "chizzy_rate_limited_total", { event: "hello_timeout" })).toBe(1);
    expect(ts.server.io.engine.clientsCount).toBe(1);
    expect(await ts.store.stats()).toMatchObject({ sessions: 1, waiting: 1 });
  });

  test("a malformed hello does not stop the deadline; a valid one does", async () => {
    ts = await startServer({ helloTimeoutMs: 150 });
    const bad = await ts.connect();
    const good = await ts.connect();
    rawEmit(bad, "session:hello", { nope: true });
    expect(await sendHello(good, hello())).toMatchObject({ ok: true });
    expect(await dropped(bad, 1000)).toBe(true);
    expect(await dropped(good, 300)).toBe(false);
  });

  test("a connection sending packets faster than the packet budget is closed, even for unknown events", async () => {
    ts = await startServer();
    const flood = await ts.connect();
    const other = await ts.connect();
    const closed = dropped(flood, 2000);
    for (let i = 0; i < PACKET_RATE_PER_CONNECTION.capacity + 50; i++) rawEmit(flood, "nothing:here", { i });
    expect(await closed).toBe(true);
    expect(await sendHello(other, hello())).toMatchObject({ ok: true });
  });

  test("unknown events and acks for nothing are ignored without an error or an exception", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const errors: unknown[] = [];
    c.on("server:error", (e) => errors.push(e));
    for (let i = 0; i < 20; i++) {
      rawEmit(c, "unknown:event", { i });
      rawEmit(c, "session:hello"); // no payload, no ack: invalid_payload (the hello bucket then rate_limits)
    }
    c.io.engine.write('399["answer to no question"]'); // a Socket.IO ACK with an id nobody is waiting for
    // Twenty hellos drained the hello bucket; wait for a token so the real one goes through.
    await delay(2100);
    expect(await sendHello(c, hello())).toMatchObject({ ok: true });
    expect(errors.length).toBe(20);
    expect(errors.map((e) => (e as { code: string }).code)).toEqual(["invalid_payload", "invalid_payload", "invalid_payload", "invalid_payload", "invalid_payload", ...Array<string>(15).fill("rate_limited")]);
    expect(await metricValue(ts, "chizzy_handler_errors_total")).toBe(0);
  });

  test("chat text is capped in UTF-16 units and the body in bytes (a 500-char message of 3-byte characters is fine)", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const got = next(cb, "chat:message");
    const text = "क".repeat(LIMITS.chatMax);
    expect(await ca.timeout(1000).emitWithAck("chat:send", { roomId, text })).toMatchObject({ ok: true });
    expect((await got).text).toBe(text);
    expect(await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: `${text}x` })).toMatchObject({ error: "invalid_payload" });
    // Combining sequences count per code unit, so a 4-byte emoji string is bounded too.
    expect(await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "😀".repeat(LIMITS.chatMax) })).toMatchObject({
      error: "invalid_payload",
    });
  });

  test("rtc:signal payloads above the SDP and candidate caps are refused", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const errors: unknown[] = [];
    ca.on("server:error", (e) => errors.push(e));
    const leak = arrives(cb, "rtc:signal", 300);
    rawEmit(ca, "rtc:signal", { roomId, description: { type: "offer", sdp: "v".repeat(LIMITS.sdpMax + 1) } });
    rawEmit(ca, "rtc:signal", { roomId, candidate: { candidate: "c".repeat(LIMITS.candidateMax + 1) } });
    rawEmit(ca, "rtc:signal", { roomId, candidate: { candidate: "c", sdpMid: "m".repeat(65) } });
    rawEmit(ca, "rtc:signal", { roomId, description: { type: "offer", sdp: "v=0" }, candidate: { candidate: "c" } });
    expect(await leak).toBe(false);
    expect(errors).toHaveLength(4);
  });

  test("rtc:signal is dropped once the call has ended, not relayed to the old partner", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const ended = next(cb, "match:ended");
    ca.emit("call:skip", { roomId });
    await ended;
    const leak = arrives(cb, "rtc:signal", 300);
    ca.emit("rtc:signal", { roomId, candidate: { candidate: "late" } });
    expect(await leak).toBe(false);
  });
});

describe("one session", () => {
  test(`one session token may hold at most ${MAX_SOCKETS_PER_SESSION} sockets; the refused one is closed at once`, async () => {
    ts = await startServer({ requireSession: true, sessionRatePerIpPerMin: 100 });
    const res = await postSession(ts, sessionBody());
    if (!res.body.ok) throw new Error(res.body.error);
    const auth = { sessionToken: res.body.sessionToken };
    for (let i = 0; i < MAX_SOCKETS_PER_SESSION; i++) expect(await tryConnect(ts, auth)).toBe("connected");
    expect(await tryConnect(ts, auth)).toBe("too_many_connections");
    expect(await metricValue(ts, "chizzy_rate_limited_total", { event: "session_connections" })).toBe(1);
    // The rejected handshake does not linger for connectTimeout: only the admitted sockets are open.
    for (let i = 0; i < 50 && ts.server.io.engine.clientsCount > MAX_SOCKETS_PER_SESSION; i++) await delay(10);
    expect(ts.server.io.engine.clientsCount).toBe(MAX_SOCKETS_PER_SESSION);
    // Another session on the same address is unaffected.
    const other = await connectWithSession(ts);
    expect(other.client.connected).toBe(true);
    // Closing one frees a slot.
    ts.clients[0]!.disconnect();
    await delay(50);
    expect(await tryConnect(ts, auth)).toBe("connected");
  });

  test("a refused session handshake is closed at once, not held for connectTimeout", async () => {
    ts = await startServer({ requireSession: true });
    expect(await tryConnect(ts, { sessionToken: "garbage" })).toBe("session_required");
    for (let i = 0; i < 50 && ts.server.io.engine.clientsCount > 0; i++) await delay(10);
    expect(ts.server.io.engine.clientsCount).toBe(0);
  });

  test("several sockets of one session hold one queue slot: each hello replaces the previous socket", async () => {
    ts = await startServer();
    const device = hello();
    const sockets = await Promise.all([ts.connect(), ts.connect(), ts.connect()]);
    for (const s of sockets) await sendHello(s, device);
    // Replaced sockets are told and disconnected; the store holds one session for the device.
    await delay(100);
    expect(await ts.store.stats()).toMatchObject({ sessions: 1, waiting: 1 });
    expect(sockets.filter((s) => s.connected)).toHaveLength(1);
  });

  test("session:preferences with unchanged values is acknowledged without a match pass", async () => {
    ts = await startServer({ sweepIntervalMs: 60_000, recheckIntervalMs: 60_000 });
    const c = await ts.connect();
    const waiting = next(c, "queue:waiting");
    await sendHello(c, hello());
    await waiting;
    // The hello acks before its own match pass; wait for that pass (it holds the lock) before counting.
    await ts.store.withLock(async () => undefined);
    let listed = 0;
    const listWaiting = ts.store.listWaiting.bind(ts.store);
    ts.store.listWaiting = () => {
      listed++;
      return listWaiting();
    };
    for (let i = 0; i < 3; i++) {
      expect(await c.timeout(1000).emitWithAck("session:preferences", { preferences: prefs() })).toEqual({ ok: true });
    }
    expect(listed).toBe(0);
    expect(await c.timeout(1000).emitWithAck("session:preferences", { preferences: prefs({ languageFilter: "hi" }) })).toEqual({ ok: true });
    expect(listed).toBe(1);
  });

  test("preference values outside the enums are refused before any handler runs", async () => {
    ts = await startServer();
    const c = await ts.connect();
    await sendHello(c, hello());
    for (const preferences of [
      { genderFilter: "robots", languageFilter: "any" },
      { genderFilter: "all", languageFilter: "ENGLISH!" },
      { genderFilter: "all", languageFilter: "x".repeat(1000) },
      { genderFilter: "all" },
    ]) {
      expect(await c.timeout(1000).emitWithAck("session:preferences", { preferences } as never)).toMatchObject({ error: "invalid_payload" });
    }
  });

  test("repeated accept, skip and decline are idempotent and cheap", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const ended = next(cb, "match:ended");
    for (let i = 0; i < 5; i++) ca.emit("call:skip", { roomId });
    for (let i = 0; i < 5; i++) ca.emit("match:accept", { roomId });
    for (let i = 0; i < 5; i++) ca.emit("match:decline", { roomId });
    expect(await ended).toEqual({ roomId, reason: "partner-skipped" });
    await delay(100);
    expect(await metricValue(ts, "chizzy_match_end_total")).toBe(1);
    expect(await metricValue(ts, "chizzy_handler_errors_total")).toBe(0);
    // Both are back in the queue exactly once.
    expect(await ts.store.withLock(() => ts.store.stats())).toEqual({ sessions: 2, waiting: 2, pendingRooms: 0, activeRooms: 0 });
  });
});

describe("matching caps", () => {
  test(`letting ${ACCEPT_TIMEOUT_STRIKES} accept windows expire puts the device on a cooldown that hello refuses`, async () => {
    ts = await startServer({ matchAcceptTimeoutMs: 100, matchAcceptGraceMs: 20 });
    const lazy = hello();
    const c = await ts.connect();
    for (let strike = 1; strike <= ACCEPT_TIMEOUT_STRIKES; strike++) {
      const partner = await ts.connect();
      const found = next(c, "match:found");
      const ended = next(c, "match:ended", 2000);
      expect(await sendHello(c, lazy)).toMatchObject({ ok: true });
      await sendHello(partner, hello());
      await found;
      expect(await ended).toMatchObject({ reason: "accept-timeout" });
      partner.disconnect();
    }
    for (let i = 0; i < 50 && (await metricValue(ts, "chizzy_accept_cooldowns_total")) === 0; i++) await delay(10);
    const refused = await sendHello(c, lazy);
    expect(refused).toMatchObject({ ok: false, error: "rate_limited" });
    expect((refused as { message?: string }).message).toContain("expire");
    // A device that accepts is not touched.
    const keen = await ts.connect();
    expect(await sendHello(keen, hello())).toMatchObject({ ok: true });
  });

  test("the side that accepted gets no strike when only the other lets the window expire", async () => {
    ts = await startServer({ matchAcceptTimeoutMs: 100, matchAcceptGraceMs: 20 });
    const { ca, cb, roomId, a } = await matchedPair(ts);
    const endA = next(ca, "match:ended", 2000);
    ca.emit("match:accept", { roomId });
    expect(await endA).toMatchObject({ reason: "timeout" });
    cb.disconnect();
    await delay(50);
    const store = ts.server.service as unknown as { safety: { acceptCooldownMs(d: string): Promise<number> } };
    expect(await store.safety.acceptCooldownMs(a.deviceId)).toBe(0);
  });

  test("a device is matched at most matchCapPerDevicePerMin times in a minute", async () => {
    ts = await startServer({ requireSession: true, matchCapPerDevicePerMin: 2, sessionRatePerIpPerMin: 100 });
    const skipper = await connectWithSession(ts);
    const errors: unknown[] = [];
    skipper.client.on("server:error", (e) => errors.push(e));
    await sendHello(skipper.client, hello({ deviceId: skipper.deviceId }));
    for (let i = 0; i < 2; i++) {
      const victim = await connectWithSession(ts);
      const found = next(skipper.client, "match:found");
      await sendHello(victim.client, hello({ deviceId: victim.deviceId }));
      const { roomId } = await found;
      const ended = next(skipper.client, "match:ended");
      skipper.client.emit("call:skip", { roomId });
      await ended;
      victim.client.disconnect();
    }
    // The second skip's re-queue is refused: over the per-minute cap.
    await delay(50);
    expect(errors).toContainEqual({ code: "rate_limited", message: MINUTE_CAP_MESSAGE });
    expect((await ts.store.getSession(skipper.client.id!))!.state).toBe("idle");
    expect(await sendHello(skipper.client, hello({ deviceId: skipper.deviceId }))).toEqual({
      ok: false,
      error: "rate_limited",
      message: MINUTE_CAP_MESSAGE,
    });
  });
});

describe("cleanup after disconnect", () => {
  test("store sizes, local bookkeeping and the socket count return to baseline", async () => {
    ts = await startServer();
    const baseline = await ts.store.stats();
    const { ca, cb } = await activePair(ts);
    const waiter = await ts.connect();
    await sendHello(waiter, hello({ profile: profile({ topics: ["books"] }), preferences: prefs({ languageFilter: "xx" }) }));
    const pending = await matchedPair(ts, hello({ profile: profile({ topics: ["art"] }) }), hello({ profile: profile({ topics: ["art"] }) }));
    expect(await ts.store.withLock(() => ts.store.stats())).toEqual({ sessions: 5, waiting: 1, pendingRooms: 1, activeRooms: 1 });
    for (const c of [ca, cb, waiter, pending.ca, pending.cb]) c.disconnect();
    for (let i = 0; i < 100 && ts.server.service.localSessionCount() > 0; i++) await delay(10);
    expect(ts.server.service.localSessionCount()).toBe(0);
    expect(await ts.store.withLock(() => ts.store.stats())).toEqual(baseline);
    expect(ts.server.io.engine.clientsCount).toBe(0);
    for (const c of [ca, cb, waiter, pending.ca, pending.cb]) {
      expect(await ts.store.getSession(c.id!)).toBeNull();
      expect(await ts.store.getPhoto(c.id!)).toBeNull();
    }
    expect(ts.server.io.sockets.sockets.size).toBe(0);
    const internals = ts.server.service as unknown as { relaxing: Map<string, unknown>; wakeAt: Map<string, unknown>; dirty: Set<string> };
    expect(internals.relaxing.size).toBe(0);
    expect(internals.wakeAt.size).toBe(0);
    expect(await metricValue(ts, "chizzy_connected_sockets")).toBe(0);
  });

  test("the device -> socket binding of a disconnected socket is released", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const h = hello();
    await sendHello(c, h);
    expect(await ts.store.getDeviceSocket(h.deviceId)).toBe(c.id!);
    c.disconnect();
    for (let i = 0; i < 100 && (await ts.store.getDeviceSocket(h.deviceId)) !== null; i++) await delay(10);
    expect(await ts.store.getDeviceSocket(h.deviceId)).toBeNull();
    expect(await ts.store.getSession(randomUUID())).toBeNull();
  });
});
