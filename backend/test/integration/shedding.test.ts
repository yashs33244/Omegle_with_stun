/**
 * Instance-wide limits and overload shedding (src/shed): limits on what all
 * clients together may open or create on one instance, and the overload
 * state that refuses new sockets and sessions while live calls keep working.
 * docs/LIMITS.md "Instance-wide limits and shedding" cites these tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CLEAR_SAMPLES, OVER_SAMPLES, SHED_RETRY_AFTER_SEC } from "../../src/shed/constants";
import type { LoadSample, LoadSampler } from "../../src/shed/LoadMonitor";
import { activePair, next, rawUpgrade, sessionBody, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

async function metricValue(t: TestServer, name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = t.server.metrics.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, x]) => (v.labels as Record<string, unknown>)[k] === x))
    .reduce((sum, v) => sum + v.value, 0);
}

function post(t: TestServer, ip: string): Promise<Response> {
  return fetch(`${t.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip, origin: "https://app.example" },
    body: JSON.stringify(sessionBody()),
  });
}

/** A sampler whose next readings the test sets; the server never samples on its own (loadSampleIntervalMs 0). */
class FakeSampler implements LoadSampler {
  current: LoadSample = { loopDelayP99Ms: 5, heapUsedBytes: 10, heapLimitBytes: 100 };
  sample(): LoadSample {
    return this.current;
  }
}

describe("instance-wide limits", () => {
  test("MAX_CONNECTIONS_TOTAL refuses the next socket from any address with 503 server_full", async () => {
    ts = await startServer({ proxyIpHeader: "x-real-ip", maxConnectionsTotal: 3 });
    const first = await ts.connect({ headers: { "X-Real-IP": "198.51.100.1" } });
    await ts.connect({ headers: { "X-Real-IP": "198.51.100.2" } });
    await ts.connect({ headers: { "X-Real-IP": "198.51.100.3" } });
    // A fresh address, far under its per-IP cap: refused by the instance cap.
    expect(await rawUpgrade(ts, { "X-Real-IP": "198.51.100.4" })).toEqual({ status: 503, body: "server_full" });
    expect(ts.server.io.engine.clientsCount).toBe(3);
    expect(await metricValue(ts, "chizzy_shed_total", { reason: "connection_cap" })).toBe(1);
    // A refused attempt holds nothing: closing one connection frees a slot.
    const released = Promise.withResolvers<void>();
    ts.server.io.sockets.sockets.get(first.id!)!.conn.once("close", () => released.resolve());
    first.disconnect();
    await released.promise;
    expect((await rawUpgrade(ts, { "X-Real-IP": "198.51.100.4" })).status).toBe(101);
  });

  test("the instance-wide session bucket refuses POST /api/session past the global rate with 503 closed and Retry-After", async () => {
    ts = await startServer({ proxyIpHeader: "x-real-ip", sessionRateTotal: { capacity: 3, refillPerSec: 0.001 } });
    // Every request from its own address: no per-IP limit is anywhere near.
    for (let i = 1; i <= 3; i++) expect((await post(ts, `198.51.100.${i}`)).status).toBe(200);
    const refused = await post(ts, "198.51.100.4");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ ok: false, error: "closed" });
    expect(refused.headers.get("retry-after")).toBe(String(SHED_RETRY_AFTER_SEC));
    // The SPA is on another origin: it can only read Retry-After when it is exposed.
    expect(refused.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect(await metricValue(ts, "chizzy_shed_total", { reason: "session_rate" })).toBe(1);
  });

  test("the kill switch's closed carries no Retry-After (only transient refusals do)", async () => {
    ts = await startServer({ proxyIpHeader: "x-real-ip" });
    await ts.server.flags.set({ new_sessions_enabled: false });
    const res = await post(ts, "198.51.100.9");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "closed" });
    expect(res.headers.get("retry-after")).toBeNull();
  });
});

describe("overload shedding", () => {
  test("while overloaded new upgrades and sessions are refused, a live call keeps relaying, /healthz stays 200; hysteresis recovers", async () => {
    const sampler = new FakeSampler();
    ts = await startServer({ proxyIpHeader: "x-real-ip" }, undefined, { loadSampler: sampler });
    const { ca, cb, roomId } = await activePair(ts);

    // One hot sample is not overload (a GC pause); OVER_SAMPLES in a row are.
    sampler.current = { ...sampler.current, loopDelayP99Ms: 350 };
    for (let i = 1; i < OVER_SAMPLES; i++) ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(false);
    ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(true);
    expect(await metricValue(ts, "chizzy_overloaded")).toBe(1);

    expect(await rawUpgrade(ts, { "X-Real-IP": "198.51.100.20" })).toEqual({ status: 503, body: "overloaded" });
    const refused = await post(ts, "198.51.100.21");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ ok: false, error: "closed" });
    expect(refused.headers.get("retry-after")).toBe(String(SHED_RETRY_AFTER_SEC));
    expect((await fetch(`${ts.url}/healthz`)).status).toBe(200);
    const ready = await fetch(`${ts.url}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "overloaded" });
    expect(await metricValue(ts, "chizzy_shed_total", { reason: "overload_socket" })).toBe(1);
    expect(await metricValue(ts, "chizzy_shed_total", { reason: "overload_session" })).toBe(1);

    // The call already running is served as before.
    const offer = { roomId, description: { type: "offer" as const, sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" } };
    const signal = next(cb, "rtc:signal");
    ca.emit("rtc:signal", offer);
    expect(await signal).toEqual(offer);
    const message = next(cb, "chat:message");
    expect(await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "still here" })).toMatchObject({ ok: true });
    expect(await message).toMatchObject({ roomId, text: "still here" });

    // Hysteresis: dropping just under the hot mark is not enough, and calm
    // samples must come CLEAR_SAMPLES in a row.
    sampler.current = { ...sampler.current, loopDelayP99Ms: 150 };
    for (let i = 0; i < CLEAR_SAMPLES * 2; i++) ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(true);
    sampler.current = { ...sampler.current, loopDelayP99Ms: 5 };
    for (let i = 1; i < CLEAR_SAMPLES; i++) ts.server.load.tick();
    sampler.current = { ...sampler.current, heapUsedBytes: 75 }; // over HEAP_CLEAR_RATIO: the streak restarts
    ts.server.load.tick();
    sampler.current = { ...sampler.current, heapUsedBytes: 10 };
    for (let i = 1; i < CLEAR_SAMPLES; i++) ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(true);
    ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(false);
    expect(await metricValue(ts, "chizzy_overloaded")).toBe(0);

    expect((await rawUpgrade(ts, { "X-Real-IP": "198.51.100.20" })).status).toBe(101);
    expect((await post(ts, "198.51.100.21")).status).toBe(200);
    expect((await fetch(`${ts.url}/readyz`)).status).toBe(200);
  });

  test("heap over its limit sheds too", async () => {
    const sampler = new FakeSampler();
    ts = await startServer({}, undefined, { loadSampler: sampler });
    sampler.current = { loopDelayP99Ms: 5, heapUsedBytes: 85, heapLimitBytes: 100 };
    for (let i = 0; i < OVER_SAMPLES; i++) ts.server.load.tick();
    expect(ts.server.load.overloaded).toBe(true);
    expect((await rawUpgrade(ts)).body).toBe("overloaded");
  });
});
