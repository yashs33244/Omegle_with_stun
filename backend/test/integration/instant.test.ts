/**
 * Instant and preview modes, the relaxation ladder and the online count over
 * real sockets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { arrives, hello, next, prefs, profile, record, sendHello, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

describe("instant and preview modes", () => {
  test("instant + instant goes straight to call:start", async () => {
    ts = await startServer();
    const ca = await ts.connect();
    const cb = await ts.connect();
    const foundA = next(ca, "match:found");
    const startA = next(ca, "call:start");
    const startB = next(cb, "call:start");
    expect(await sendHello(ca, hello({ mode: "instant" }))).toMatchObject({ ok: true, mode: "instant" });
    expect(await sendHello(cb, hello({ mode: "instant" }))).toMatchObject({ ok: true, mode: "instant" });
    const fa = await foundA;
    expect(fa.mode).toBe("instant");
    const [sa, sb] = await Promise.all([startA, startB]);
    expect(sa).toMatchObject({ roomId: fa.roomId, initiator: true });
    expect(sb).toMatchObject({ roomId: fa.roomId, initiator: false });
  });

  test("instant + preview: the preview side gets the card, the instant side waits for it", async () => {
    ts = await startServer({ matchAcceptTimeoutMs: 30_000 });
    const instant = await ts.connect();
    const preview = await ts.connect();
    const foundI = next(instant, "match:found");
    const foundP = next(preview, "match:found");
    const partnerAccepted = next(preview, "match:partner-accepted");
    const early = arrives(instant, "call:start", 200);
    await sendHello(instant, hello({ mode: "instant" }));
    await sendHello(preview, hello({ mode: "preview" }));
    const [fi, fp] = await Promise.all([foundI, foundP]);
    expect(fi.mode).toBe("instant");
    expect(fp.mode).toBe("preview");
    expect(fp.expiresAt - fp.serverNow).toBe(30_000);
    expect(await partnerAccepted).toEqual({ roomId: fp.roomId });
    expect(await early).toBe(false);

    const startI = next(instant, "call:start");
    const startP = next(preview, "call:start");
    preview.emit("match:accept", { roomId: fp.roomId });
    await Promise.all([startI, startP]);
  });

  test("instant + preview: a Pass on the card re-queues the instant side", async () => {
    ts = await startServer();
    const instant = await ts.connect();
    const preview = await ts.connect();
    const foundP = next(preview, "match:found");
    await sendHello(instant, hello({ mode: "instant" }));
    await sendHello(preview, hello({ mode: "preview" }));
    const { roomId } = await foundP;
    const ended = next(instant, "match:ended");
    const requeued = next(instant, "queue:waiting");
    preview.emit("match:decline", { roomId });
    expect(await ended).toEqual({ roomId, reason: "partner-declined" });
    await requeued;
  });

  test("default_mode=preview turns instant requests into preview", async () => {
    ts = await startServer();
    await ts.server.flags.set({ default_mode: "preview" });
    const ca = await ts.connect();
    const cb = await ts.connect();
    const foundA = next(ca, "match:found");
    const noStart = arrives(ca, "call:start", 300);
    expect(await sendHello(ca, hello({ mode: "instant" }))).toMatchObject({ ok: true, mode: "preview" });
    await sendHello(cb, hello({ mode: "instant" }));
    expect((await foundA).mode).toBe("preview");
    expect(await noStart).toBe(false);
  });
});

describe("relaxation ladder", () => {
  const ladder = { relaxTopicsAfterMs: 250, relaxLanguageAfterMs: 600 };

  test("no shared topic: matched once topics relax, with queue:waiting steps", async () => {
    ts = await startServer(ladder);
    const ca = await ts.connect();
    const cb = await ts.connect();
    const waits = record(ca, "queue:waiting");
    const found = next(ca, "match:found", 2000);
    const started = Date.now();
    await sendHello(ca, hello({ profile: profile({ topics: ["music"] }) }));
    await sendHello(cb, hello({ profile: profile({ topics: ["art"] }) }));
    expect(await arrives(ca, "match:found", 150)).toBe(false);
    await found;
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    // Step 1 may be reached by the match pass a moment before the sweeper announces it.
    expect(waits[0]!.relaxStep).toBe(0);
  });

  test("different languages wait for the last step; a language filter never relaxes", async () => {
    ts = await startServer(ladder);
    const en = await ts.connect();
    const hi = await ts.connect();
    const filtered = await ts.connect();
    const waits = record(en, "queue:waiting");
    const notFiltered = arrives(filtered, "match:found", 1200);
    // Wants French speakers only: a hard rule that never relaxes.
    await sendHello(filtered, hello({ profile: profile({ language: "en" }), preferences: prefs({ languageFilter: "fr" }) }));
    const found = next(en, "match:found", 2000);
    const started = Date.now();
    await sendHello(en, hello({ profile: profile({ language: "en" }) }));
    await sendHello(hi, hello({ profile: profile({ language: "hi" }) }));
    const f = await found;
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(f.partner.language).toBe("hi");
    // Step 2 may be reached by the match pass a moment before the sweeper announces it.
    expect(waits.map((w) => w.relaxStep).slice(0, 2)).toEqual([0, 1]);
    expect(await notFiltered).toBe(false);
  });

  test("a long waiter accepts a newcomer at once", async () => {
    ts = await startServer(ladder);
    const old = await ts.connect();
    await sendHello(old, hello({ profile: profile({ language: "hi", topics: ["art"] }) }));
    await next(old, "queue:waiting", 2000).catch(() => undefined);
    // Wait until the old waiter reached the last step.
    await new Promise((r) => setTimeout(r, 700));
    const newcomer = await ts.connect();
    const found = next(newcomer, "match:found", 300);
    await sendHello(newcomer, hello({ profile: profile({ language: "en", topics: ["music"] }) }));
    expect((await found).partner.language).toBe("hi");
  });
});

describe("online count", () => {
  test("queue:waiting carries the real count only at or above the threshold", async () => {
    ts = await startServer({ heartbeatIntervalMs: 30 });
    await ts.server.flags.set({ online_count_threshold: 2, premium_filters_enabled: false });
    const a = await ts.connect();
    const b = await ts.connect();
    // Incompatible on a hard rule, so both keep waiting.
    await sendHello(a, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    await sendHello(b, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    await new Promise((r) => setTimeout(r, 120)); // let the sweeper count
    const c = await ts.connect();
    const wait = next(c, "queue:waiting");
    await sendHello(c, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    const w = await wait;
    expect(w.relaxStep).toBe(0);
    expect(w.online).toBeGreaterThanOrEqual(2); // the sweeper may already count c itself

    await ts.server.flags.set({ online_count_threshold: 50 });
    const d = await ts.connect();
    const wait2 = next(d, "queue:waiting");
    await sendHello(d, hello({ profile: profile({ gender: "male" }), preferences: prefs({ genderFilter: "female" }) }));
    expect(await wait2).toEqual({ relaxStep: 0 });
  });
});
