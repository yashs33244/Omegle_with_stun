/**
 * Matching stays incremental (BUGS.md B-04): with thousands of sessions
 * waiting that cannot match anyone, neither one more hello nor the sweeper's
 * periodic recheck may scan all pairs and stall the event loop.
 */
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { HelloAck } from "../../src/protocol";
import type { Session } from "../../src/store/MatchStore";
import { MemoryStore } from "../../src/store/MemoryStore";
import { hello, prefs, profile, startServer, type TestServer } from "../helpers";

let ts: TestServer | undefined;
afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** Stores `count` waiting sessions that only accept Hindi speakers, so nobody here matches anybody. */
async function fillUnmatchable(store: MemoryStore, instanceId: string, count: number): Promise<void> {
  const now = Date.now();
  const { photo: _photo, ...base } = profile({ topics: ["music"] });
  for (let i = 0; i < count; i++) {
    const s: Session = {
      socketId: `waiter-${i}`,
      deviceId: randomUUID(),
      instanceId,
      profile: base,
      preferences: prefs({ languageFilter: "hi" }),
      state: "waiting",
      waitingSince: now - count + i,
      connectedAt: now,
    };
    await store.putSession(s);
    await store.addWaiting(s.socketId, s.waitingSince!);
  }
}

test("one hello with 2000 unmatchable waiters completes in under 50 ms", async () => {
  const store = new MemoryStore();
  // Long sweep intervals: measure the hello alone, not a concurrent recheck.
  ts = await startServer({ sweepIntervalMs: 60_000, recheckIntervalMs: 60_000 }, store);
  await fillUnmatchable(store, ts.config.instanceId, 2000);
  const c = await ts.connect();
  const payload = hello({ profile: profile({ topics: ["music"], language: "en" }) });

  // Warm up the code path once, then measure a fresh socket.
  await ts.server.service.hello(c.id!, payload, () => {});
  // Best of three fresh sockets, so one GC pause or busy CI core does not fail the run.
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const socket = await ts.connect();
    let ack: HelloAck | undefined;
    // Wants French speakers, so it matches nobody here.
    const payloadN = hello({ profile: payload.profile, preferences: prefs({ languageFilter: "fr" }) });
    const started = performance.now();
    await ts.server.service.hello(socket.id!, payloadN, (res) => (ack = res));
    best = Math.min(best, performance.now() - started);
    expect(ack).toMatchObject({ ok: true });
  }
  expect(await store.listWaiting()).toHaveLength(2004);
  expect(best).toBeLessThan(50);
});

test("the sweeper's recheck keeps /healthz fast with 4000 unmatchable waiters", async () => {
  const store = new MemoryStore();
  // A recheck on every sweep, 50x more often than in production. Before the
  // fix each one was a full O(waiting^2) pass: about 700 ms at 4000 waiters.
  ts = await startServer({ sweepIntervalMs: 100, recheckIntervalMs: 100 }, store);
  await fillUnmatchable(store, ts.config.instanceId, 4000);
  const deadline = performance.now() + 1500;
  let worst = 0;
  let requests = 0;
  while (performance.now() < deadline) {
    const started = performance.now();
    const res = await fetch(`${ts.url}/healthz`);
    expect(res.status).toBe(200);
    worst = Math.max(worst, performance.now() - started);
    requests++;
  }
  expect(requests).toBeGreaterThan(10);
  expect(worst).toBeLessThan(100);
});
