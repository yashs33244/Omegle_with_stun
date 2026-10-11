/**
 * Per-call ICE (mocked Cloudflare API), call:failed, call:telemetry and
 * moderation:signal over real sockets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { activePair, arrives, hello, matchedPair, next, sendHello, startServer, type TestServer } from "../helpers";
import { CF_RESPONSE, fakeCloudflare } from "../fixtures/cloudflare";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

const cloudflare = {
  turnProvider: "cloudflare" as const,
  cfTurnKeyId: "key-1",
  cfTurnApiToken: "token-1",
  // Every test connects from 127.0.0.1; keep the per-IP cap out of the way (it has its own test).
  turnMaxPerIpHour: 1_000_000,
};

async function metricValue(t: TestServer, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = t.server.metrics.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, x]) => (v.labels as Record<string, unknown>)[k] === x))
    .reduce((sum, v) => sum + v.value, 0);
}

describe("call:start ICE servers", () => {
  test("hello carries STUN only; call:start carries Cloudflare TURN without port 53", async () => {
    const cf = fakeCloudflare();
    ts = await startServer(cloudflare, undefined, { fetch: cf.fetch });
    const ca = await ts.connect();
    expect(await sendHello(ca, hello())).toMatchObject({ ok: true, iceServers: [{ urls: ts.config.stunUrls }] });
    const cb = await ts.connect();
    const found = next(cb, "match:found");
    await sendHello(cb, hello());
    const { roomId } = await found;
    const startA = next(ca, "call:start");
    const startB = next(cb, "call:start");
    ca.emit("match:accept", { roomId });
    cb.emit("match:accept", { roomId });
    const [sa, sb] = await Promise.all([startA, startB]);
    for (const s of [sa, sb]) {
      expect(s.iceServers[0]).toEqual({ urls: ts.config.stunUrls });
      const turn = s.iceServers.find((x) => x.username === "cf-user")!;
      expect(turn.credential).toBe("cf-pass");
      expect(turn.urls).toContain("turns:turn.cloudflare.com:443?transport=tcp");
      expect((turn.urls as string[]).some((u) => /:53(\?|$)/.test(u))).toBe(false);
      expect(s).toMatchObject({ maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true });
    }
    expect(cf.calls.length).toBe(2); // one credential set per device
    expect(JSON.parse(String(cf.calls[0]!.init?.body))).toEqual({ ttl: 7200 });
    expect(CF_RESPONSE.iceServers[1]!.urls).toContain("turn:turn.cloudflare.com:53?transport=udp");
  });

  test("flags drive bitrate caps; turn_enabled=false means STUN only and no private mode", async () => {
    const cf = fakeCloudflare();
    ts = await startServer(cloudflare, undefined, { fetch: cf.fetch });
    await ts.server.flags.set({ turn_enabled: false, video_max_kbps: 800, relay_video_max_kbps: 300 });
    const { startA } = await activePair(ts);
    expect(startA).toMatchObject({
      iceServers: [{ urls: ts.config.stunUrls }],
      maxBitrateKbps: 800,
      relayMaxBitrateKbps: 300,
      privateModeAllowed: false,
    });
    expect(cf.calls.length).toBe(0);
  });

  test("a failing Cloudflare API falls back to STUN only", async () => {
    ts = await startServer(cloudflare, undefined, { fetch: fakeCloudflare({ status: 503 }).fetch });
    const { startA, startB } = await activePair(ts);
    for (const s of [startA, startB]) expect(s).toMatchObject({ iceServers: [{ urls: ts.config.stunUrls }], privateModeAllowed: false });
    expect(await metricValue(ts, "chizzy_turn_credentials_total", { result: "error" })).toBe(2);
  });

  test("the per-IP hourly cap applies across devices", async () => {
    ts = await startServer(
      { ...cloudflare, proxyIpHeader: "x-real-ip", turnMaxPerIpHour: 2, turnCacheSeconds: 0 },
      undefined,
      { fetch: fakeCloudflare().fetch },
    );
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}-${randomUUID()}`;
    const connect = () => ts.connect({ headers: { "x-real-ip": ip } });
    const ca = await connect();
    const cb = await connect();
    const foundA = next(ca, "match:found");
    await sendHello(ca, hello());
    await sendHello(cb, hello());
    const { roomId } = await foundA;
    const startA = next(ca, "call:start");
    const startB = next(cb, "call:start");
    ca.emit("match:accept", { roomId });
    cb.emit("match:accept", { roomId });
    const starts = await Promise.all([startA, startB]);
    expect(starts.every((s) => s.privateModeAllowed)).toBe(true);
    // Third credential set from the same IP within the hour: STUN only.
    const cc = await connect();
    const cd = await ts.connect();
    const foundC = next(cc, "match:found");
    ca.disconnect();
    cb.disconnect();
    await sendHello(cc, hello());
    await sendHello(cd, hello());
    const room2 = (await foundC).roomId;
    const startC = next(cc, "call:start");
    cc.emit("match:accept", { roomId: room2 });
    cd.emit("match:accept", { roomId: room2 });
    expect(await startC).toMatchObject({ iceServers: [{ urls: ts.config.stunUrls }], privateModeAllowed: false });
  });
});

describe("call:failed", () => {
  test("a member of the active room ends it for both with connection-failed and both are re-queued", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const endedA = next(ca, "match:ended");
    const endedB = next(cb, "match:ended");
    const waitA = next(ca, "queue:waiting");
    const waitB = next(cb, "queue:waiting");
    ca.emit("call:failed", { roomId, reason: "timeout" });
    expect(await endedA).toEqual({ roomId, reason: "connection-failed" });
    expect(await endedB).toEqual({ roomId, reason: "connection-failed" });
    await Promise.all([waitA, waitB]);
    // Kept apart briefly, so not matched straight back together.
    expect(await arrives(ca, "match:found", 200)).toBe(false);
    expect(await metricValue(ts, "chizzy_call_failed_total", { reason: "timeout" })).toBe(1);
  });

  test("non-members and pending rooms cannot end a call", async () => {
    ts = await startServer({ matchAcceptTimeoutMs: 5000 });
    const pending = await matchedPair(ts);
    pending.ca.emit("call:failed", { roomId: pending.roomId, reason: "ice-failed" });
    expect(await arrives(pending.cb, "match:ended", 200)).toBe(false);

    const active = await activePair(ts);
    const intruder = await ts.connect();
    await sendHello(intruder, hello({ preferences: { genderFilter: "female", languageFilter: "any" } }));
    intruder.emit("call:failed", { roomId: active.roomId, reason: "ice-failed" });
    expect(await arrives(active.ca, "match:ended", 200)).toBe(false);
  });

  test("is rate limited", async () => {
    ts = await startServer();
    const c = await ts.connect();
    await sendHello(c, hello());
    const errors: unknown[] = [];
    c.on("server:error", (e) => errors.push(e));
    for (let i = 0; i < 30; i++) c.emit("call:failed", { roomId: randomUUID(), reason: "timeout" });
    await new Promise((r) => setTimeout(r, 150));
    expect(errors.some((e) => (e as { code: string }).code === "rate_limited")).toBe(true);
  });
});

describe("call:telemetry and moderation:signal", () => {
  test("telemetry feeds chizzy_calls_total and the time-to-connect histogram, once per room", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const t = { roomId, outcome: "connected" as const, timeToConnectMs: 1800, localCandidateType: "relay" as const, privateMode: true };
    ca.emit("call:telemetry", t);
    ca.emit("call:telemetry", t); // duplicate: ignored
    cb.emit("call:telemetry", { roomId, outcome: "ice-failed", privateMode: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(await metricValue(ts, "chizzy_calls_total", { outcome: "connected", local_candidate: "relay", private: "true" })).toBe(1);
    expect(await metricValue(ts, "chizzy_calls_total", { outcome: "ice-failed", local_candidate: "unknown", private: "false" })).toBe(1);
    const text = await (await fetch(`${ts.url}/metrics`)).text();
    expect(text).toContain('chizzy_time_to_connect_seconds_bucket{le="2"} 1');
    expect(text).not.toContain("127.0.0.1");
  });

  test("moderation signals are counted per kind; invalid kinds are rejected", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    ca.emit("moderation:signal", { roomId, kind: "virtual-camera" });
    cb.emit("moderation:signal", { roomId, kind: "nsfw-blur" });
    cb.emit("moderation:signal", { roomId, kind: "nsfw-blur" });
    const err = next(ca, "server:error");
    (ca.emit as (ev: string, p: unknown) => void)("moderation:signal", { roomId, kind: "frames" });
    expect((await err).code).toBe("invalid_payload");
    await new Promise((r) => setTimeout(r, 100));
    expect(await metricValue(ts, "chizzy_moderation_signals_total", { kind: "virtual-camera" })).toBe(1);
    expect(await metricValue(ts, "chizzy_moderation_signals_total", { kind: "nsfw-blur" })).toBe(1);
  });
});

describe("early skips and low priority", () => {
  test("partners who skip within 3 s count as early skips and can lower priority", async () => {
    ts = await startServer({ earlySkipMinCalls: 1, earlySkipShare: 0.5, lowPriorityDelayMs: 1_000 });
    const { ca, cb } = await activePair(ts);
    const requeued = next(cb, "queue:waiting");
    ca.emit("call:skip"); // ca skips cb right away
    await requeued;
    for (let i = 0; i < 50 && (await metricValue(ts, "chizzy_low_priority_total", { cause: "early-skip" })) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await metricValue(ts, "chizzy_early_skips_total")).toBe(1);
    expect(await metricValue(ts, "chizzy_low_priority_total", { cause: "early-skip" })).toBe(1);

    // cb is now held back for lowPriorityDelayMs before anyone new is matched with it.
    ca.disconnect();
    const fresh = await ts.connect();
    const found = next(fresh, "match:found", 3000);
    await sendHello(fresh, hello());
    expect(await arrives(fresh, "match:found", 300)).toBe(false);
    await found;
  });
});
