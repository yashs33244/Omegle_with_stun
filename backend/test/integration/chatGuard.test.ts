/**
 * Server-side chat guard, safety nudges and the display-name guard over real sockets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HIDDEN, nicknameFor } from "../../src/safety/guard";
import { activePair, arrives, hello, next, profile, record, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

describe("chat guard", () => {
  test("hides contact details early in the call, nudges the sender and both sides", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const nudgesA = record(ca, "safety:nudge");
    const nudgesB = record(cb, "safety:nudge");
    const msg = next(cb, "chat:message");
    const ack = await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "add me snap: rahul_22 or 98765 43210" });
    expect(ack).toMatchObject({ ok: true, redacted: true });
    const m = await msg;
    expect(m.redacted).toBe(true);
    expect(m.text).toBe(`add me ${HIDDEN} or ${HIDDEN}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(nudgesA).toEqual([
      { roomId, kind: "link-hidden" },
      { roomId, kind: "contact-sharing" },
    ]);
    expect(nudgesB).toEqual([{ roomId, kind: "contact-sharing" }]);
  });

  test("solicitation phrases nudge both sides without hiding the text", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const nudgeA = next(ca, "safety:nudge");
    const nudgeB = next(cb, "safety:nudge");
    const msg = next(ca, "chat:message");
    const ack = await cb.timeout(1000).emitWithAck("chat:send", { roomId, text: "kapde utaro na" });
    expect(ack).toMatchObject({ ok: true, redacted: false });
    expect(await msg).toMatchObject({ text: "kapde utaro na", redacted: false });
    expect(await nudgeA).toEqual({ roomId, kind: "solicitation" });
    expect(await nudgeB).toEqual({ roomId, kind: "solicitation" });
    // One nudge per kind per room per minute.
    await cb.timeout(1000).emitWithAck("chat:send", { roomId, text: "kapde utaro" });
    expect(await arrives(ca, "safety:nudge", 150)).toBe(false);
  });

  test("ordinary chat is untouched and after the guarded window links pass", async () => {
    ts = await startServer({ chatGuardMs: 200 });
    const { ca, cb, roomId } = await activePair(ts);
    const plain = next(cb, "chat:message");
    await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "hi! where are you from?" });
    expect(await plain).toMatchObject({ text: "hi! where are you from?", redacted: false });
    await new Promise((r) => setTimeout(r, 250));
    const later = next(cb, "chat:message");
    const ack = await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "see example.com" });
    expect(ack).toMatchObject({ ok: true, redacted: false });
    expect(await later).toMatchObject({ text: "see example.com", redacted: false });
  });
});

describe("name guard", () => {
  test("a name with a slur or a handle becomes a generated nickname; hello still succeeds", async () => {
    ts = await startServer();
    const a = await ts.connect();
    const b = await ts.connect();
    const foundB = next(b, "match:found");
    const bad = hello({ profile: profile({ name: "insta: priya_22" }) });
    expect(await a.timeout(1000).emitWithAck("session:hello", bad)).toMatchObject({ ok: true });
    await b.timeout(1000).emitWithAck("session:hello", hello({ profile: profile({ name: "Asha" }) }));
    const f = await foundB;
    expect(f.partner.name).toBe(nicknameFor(bad.deviceId));
    expect(f.partner.name).toMatch(/^Stranger \d{4}$/);
    const metric = await ts.server.metrics.registry.getSingleMetric("chizzy_names_replaced_total")!.get();
    expect(metric.values[0]!.value).toBe(1);
  });
});
