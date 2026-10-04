/**
 * Hostile input, reports and bans, connection caps, HTTP endpoints and shutdown.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { io as ioClient } from "socket.io-client";
import { loadConfig } from "../../src/config";
import { MemoryStore } from "../../src/store/MemoryStore";
import {
  activePair,
  arrives,
  delay,
  hello,
  matchedPair,
  next,
  profile,
  sendHello,
  startServer,
  type Client,
  type TestServer,
} from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

/** Emits an arbitrary (possibly invalid) event and resolves with its ack. */
function rawAck(client: Client, event: string, ...args: unknown[]): Promise<unknown> {
  return (client.timeout(1000).emitWithAck as (ev: string, ...a: unknown[]) => Promise<unknown>)(event, ...args);
}
function rawEmit(client: Client, event: string, ...args: unknown[]): void {
  (client.emit as (ev: string, ...a: unknown[]) => void)(event, ...args);
}

describe("malformed payloads", () => {
  test("never crash the server and get invalid_payload", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const valid = hello();
    const cases: unknown[] = [
      undefined,
      null,
      42,
      "hello",
      [],
      { ...valid, profile: { ...valid.profile, topics: "general" } },
      { ...valid, profile: { ...valid.profile, name: "x".repeat(100_000) } },
      { ...valid, deviceId: "not-a-uuid" },
      { protocolVersion: valid.protocolVersion },
      { ...valid, profile: { ...valid.profile, photo: "https://tracker.example.com/p.png" } },
      { ...valid, preferences: { genderFilter: "unspecified", languageFilter: "any" } },
    ];
    for (const payload of cases) {
      // A fresh socket per case so the hello rate limit does not kick in.
      const fresh = await ts.connect();
      expect(await rawAck(fresh, "session:hello", payload)).toMatchObject({ ok: false, error: "invalid_payload" });
      fresh.disconnect();
    }

    // Events without an ack answer with server:error instead.
    const errors: unknown[] = [];
    c.on("server:error", (e) => errors.push(e));
    rawEmit(c, "match:accept");
    rawEmit(c, "match:accept", { roomId: "nope" });
    rawEmit(c, "rtc:signal", { roomId: randomUUID() });
    rawEmit(c, "rtc:signal", null);
    rawEmit(c, "chat:typing", { roomId: randomUUID(), typing: "yes" });
    rawEmit(c, "unknown:event", { a: 1 });
    expect(await rawAck(c, "chat:send", { roomId: randomUUID(), text: "" })).toMatchObject({ error: "invalid_payload" });
    expect(await rawAck(c, "report:submit", { roomId: randomUUID(), reason: "because" })).toMatchObject({
      error: "invalid_payload",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.length).toBe(5);
    expect(errors.every((e) => (e as { code: string }).code === "invalid_payload")).toBe(true);

    // The socket and the server still work.
    expect(await sendHello(c, valid)).toMatchObject({ ok: true });
    const health = await fetch(`${ts.url}/healthz`);
    expect(health.status).toBe(200);
  });

  test("a failing store yields an internal error, not a crash", async () => {
    const store = new MemoryStore();
    store.getBan = () => Promise.reject(new Error("store exploded"));
    ts = await startServer({}, store);
    const c = await ts.connect();
    expect(await sendHello(c, hello())).toEqual({ ok: false, error: "internal" });
    expect((await fetch(`${ts.url}/healthz`)).status).toBe(200);
  });

  test("a wrong protocol version is reported as unsupported_version", async () => {
    ts = await startServer();
    const c = await ts.connect();
    expect(await rawAck(c, "session:hello", { ...hello(), protocolVersion: 1 })).toMatchObject({
      ok: false,
      error: "unsupported_version",
    });
  });

  test("packets above the 256 KB buffer limit drop only that client", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const closed = new Promise<void>((r) => c.once("disconnect", () => r()));
    rawEmit(c, "chat:send", { roomId: randomUUID(), text: "x".repeat(300 * 1024) });
    await closed;
    const other = await ts.connect();
    expect(await sendHello(other, hello())).toMatchObject({ ok: true });
  });

  test("binary packets close the connection instead of piling up attachments", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const closed = new Promise<void>((r) => c.once("disconnect", () => r()));
    // A BINARY_EVENT header announcing a million attachments, then binary
    // frames that each pass the per-packet size check.
    const engine = c.io.engine;
    engine.write('51000000-["chat:send",{"_placeholder":true,"num":0}]');
    for (let i = 0; i < 5; i++) engine.write(new Uint8Array(64 * 1024));
    const dropped = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
    expect(dropped).toBe(true);
    const other = await ts.connect();
    expect(await sendHello(other, hello())).toMatchObject({ ok: true });
  });

  test("hello is rate limited", async () => {
    ts = await startServer();
    const c = await ts.connect();
    const payload = hello();
    const acks = await Promise.all(Array.from({ length: 8 }, () => sendHello(c, payload)));
    expect(acks.filter((a) => !a.ok && a.error === "rate_limited").length).toBeGreaterThanOrEqual(3);
  });
});

describe("reports and bans", () => {
  test("a report ends the call, blocks the pair and hides the reason from the reported side", async () => {
    ts = await startServer();
    const { ca, cb, roomId, a, b } = await activePair(ts);
    const endA = next(ca, "match:ended");
    const endB = next(cb, "match:ended");
    const ack = await ca.timeout(1000).emitWithAck("report:submit", { roomId, reason: "spam", details: "ads" });
    expect(ack).toEqual({ ok: true });
    expect(await endA).toEqual({ roomId, reason: "reported" });
    expect(await endB).toEqual({ roomId, reason: "partner-skipped" });
    const block = await ts.store.getBlock(a.deviceId, b.deviceId);
    expect(block!.until - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(await ts.store.countReporters(b.deviceId, 0)).toBe(1);
    expect(await arrives(ca, "match:found", 300)).toBe(false);
  });

  test("reporting a room you are not in fails", async () => {
    ts = await startServer();
    const pair = await matchedPair(ts);
    const outsider = await ts.connect();
    await sendHello(outsider, hello({ profile: profile({ topics: ["books"] }) }));
    const ack = await outsider.timeout(1000).emitWithAck("report:submit", { roomId: pair.roomId, reason: "spam" });
    expect(ack).toEqual({ ok: false, error: "not_in_room" });
  });

  test("three distinct reporters ban a device; its next hello fails", async () => {
    ts = await startServer();
    const target = hello({ profile: profile({ topics: ["general", "music", "art"] }) });
    const ct = await ts.connect();
    await sendHello(ct, target);

    const reporterTopics = [["general"], ["music"], ["art"]] as const;
    for (let i = 0; i < reporterTopics.length; i++) {
      const r = await ts.connect();
      const foundT = next(ct, "match:found");
      const foundR = next(r, "match:found");
      await sendHello(r, hello({ profile: profile({ topics: [...reporterTopics[i]!] }) }));
      const { roomId } = await foundR;
      await foundT;
      const banned = i === 2 ? next(ct, "server:error") : null;
      const requeued = i < 2 ? next(ct, "queue:waiting") : null;
      expect(await r.timeout(1000).emitWithAck("report:submit", { roomId, reason: "harassment" })).toEqual({ ok: true });
      if (banned) expect(await banned).toEqual({ code: "banned" });
      if (requeued) await requeued;
      r.disconnect();
    }

    expect(await ts.store.getBan(target.deviceId)).not.toBeNull();
    const session = await ts.store.getSession(ct.id!);
    expect(session!.state).toBe("idle");
    expect((await ts.store.listWaiting()).includes(ct.id!)).toBe(false);

    const again = await ts.connect();
    expect(await sendHello(again, target)).toEqual({ ok: false, error: "banned" });
  });
});

describe("connection limits", () => {
  test("per-IP cap honors X-Real-IP when TRUST_PROXY is on", async () => {
    ts = await startServer({ trustProxy: true, maxConnectionsPerIp: 2 });
    const headers = { "X-Real-IP": "203.0.113.7" };
    await ts.connect({ headers });
    const second = await ts.connect({ headers });
    await expect(ts.connect({ headers })).rejects.toThrow("too_many_connections");
    await ts.connect({ headers: { "X-Real-IP": "203.0.113.8" } });

    // Closing a connection frees a slot.
    second.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    await ts.connect({ headers });
  });

  test("reconnecting does not refill the rate limits: new connections per IP are rate limited", async () => {
    ts = await startServer({ trustProxy: true, connectRatePerIp: loadConfig({}).connectRatePerIp });
    const headers = { "X-Real-IP": "203.0.113.9" };
    let refused: unknown;
    for (let i = 0; i < 50 && refused === undefined; i++) {
      try {
        const c = await ts.connect({ headers });
        expect(await sendHello(c, hello())).toMatchObject({ ok: true });
        c.disconnect();
      } catch (err) {
        refused = err;
      }
    }
    expect(String(refused)).toContain("rate_limited");
    // Other addresses are unaffected.
    await ts.connect({ headers: { "X-Real-IP": "203.0.113.10" } });
  });

  test("X-Real-IP is ignored when TRUST_PROXY is off", async () => {
    ts = await startServer({ trustProxy: false, maxConnectionsPerIp: 2 });
    await ts.connect({ headers: { "X-Real-IP": "203.0.113.1" } });
    await ts.connect({ headers: { "X-Real-IP": "203.0.113.2" } });
    await expect(ts.connect({ headers: { "X-Real-IP": "203.0.113.3" } })).rejects.toThrow("too_many_connections");
  });

  test("CORS allowlist rejects other origins for polling handshakes", async () => {
    ts = await startServer({ corsOrigins: ["https://chizzy.example.com"] });
    const ok = await fetch(`${ts.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: "https://chizzy.example.com" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://chizzy.example.com");
    const bad = await fetch(`${ts.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("WebSocket handshakes from origins outside the allowlist are refused", async () => {
    ts = await startServer({ corsOrigins: ["https://chizzy.example.com"] });
    await ts.connect({ headers: { Origin: "https://chizzy.example.com" } });
    await ts.connect(); // no Origin: a non-browser client
    await expect(ts.connect({ headers: { Origin: "https://evil.example.com" } })).rejects.toThrow();
  });
});

describe("HTTP endpoints", () => {
  test("healthz, health alias, readyz, metrics, 404", async () => {
    ts = await startServer();
    for (const path of ["/healthz", "/health"]) {
      const res = await fetch(`${ts.url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    }
    const ready = await fetch(`${ts.url}/readyz`);
    expect(ready.status).toBe(200);
    const metrics = await fetch(`${ts.url}/metrics`);
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    for (const name of [
      "chizzy_connected_sockets",
      "chizzy_waiting_sessions",
      "chizzy_active_rooms",
      "chizzy_matches_total",
      "chizzy_match_end_total",
      "chizzy_rate_limited_total",
    ]) {
      expect(text).toContain(name);
    }
    const missing = await fetch(`${ts.url}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(metrics.headers.get("x-powered-by")).toBeNull();
  });

  test("metrics require the bearer token when METRICS_TOKEN is set", async () => {
    ts = await startServer({ metricsToken: "t0ken" });
    expect((await fetch(`${ts.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${ts.url}/metrics`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${ts.url}/metrics`, { headers: { Authorization: "Bearer t0ken" } })).status).toBe(200);
  });

  test("readyz answers 503 when the store is down", async () => {
    const store = new MemoryStore();
    store.ping = () => Promise.reject(new Error("down"));
    ts = await startServer({}, store);
    expect((await fetch(`${ts.url}/readyz`)).status).toBe(503);
  });
});

describe("graceful close", () => {
  test("tells clients, clears local sessions and closes sockets", async () => {
    ts = await startServer();
    const { ca, cb } = await activePair(ts);
    const shutA = next(ca, "server:shutdown");
    const shutB = next(cb, "server:shutdown");
    const gone = new Promise<void>((r) => ca.once("disconnect", () => r()));
    await ts.server.close();
    await Promise.all([shutA, shutB, gone]);
    expect(await ts.store.stats()).toEqual({ sessions: 0, waiting: 0, pendingRooms: 0, activeRooms: 0 });
    // New connections are refused.
    const late = ioClient(ts.url, { transports: ["websocket"], reconnection: false, timeout: 500 });
    const failed = await new Promise<boolean>((r) => {
      late.once("connect", () => r(false));
      late.once("connect_error", () => r(true));
    });
    late.close();
    expect(failed).toBe(true);
  });

  test("resolves only after the disconnect cleanups have finished", async () => {
    ts = await startServer();
    await activePair(ts);
    const clients = await Promise.all(Array.from({ length: 4 }, () => ts.connect()));
    await Promise.all(clients.map((c) => sendHello(c, hello())));
    const store = ts.store;
    const withLock = store.withLock.bind(store);
    let inFlight = 0;
    store.withLock = async (fn) => {
      inFlight++;
      try {
        await delay(20);
        return await withLock(fn);
      } finally {
        inFlight--;
      }
    };
    await ts.server.close();
    // The caller closes the store next; nothing may still be using it.
    expect(inFlight).toBe(0);
  });
});
