/**
 * Matching stays incremental (BUGS.md B-04): with 2000 sessions waiting that
 * cannot match anyone, one more hello must not scan all pairs.
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

test("one hello with 2000 unmatchable waiters completes in under 50 ms", async () => {
  const store = new MemoryStore();
  // Long sweep intervals: measure the hello alone, not a concurrent full pass.
  ts = await startServer({ sweepIntervalMs: 60_000, fullMatchPassIntervalMs: 60_000 }, store);
  const now = Date.now();
  const { photo: _photo, ...base } = profile({ topics: ["music"] });
  for (let i = 0; i < 2000; i++) {
    // Waiters only accept Hindi speakers, so nobody here matches anybody.
    const s: Session = {
      socketId: `waiter-${i}`,
      deviceId: randomUUID(),
      instanceId: ts.config.instanceId,
      profile: base,
      preferences: prefs({ languageFilter: "hi" }),
      mode: "preview",
      state: "waiting",
      waitingSince: now - 2000 + i,
      connectedAt: now,
    };
    await store.putSession(s);
    await store.addWaiting(s.socketId, s.waitingSince!);
  }
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
