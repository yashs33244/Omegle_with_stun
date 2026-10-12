/**
 * Spark prompts and caption relay over real sockets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CAPTIONS, SPARK, type CaptionSegmentPayload } from "../../src/protocol";
import { SPARK_PROMPTS } from "../../src/spark/catalog";
import { activePair, arrives, delay, hello, next, profile, sendHello, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

describe("spark", () => {
  test("both members get the same prompt id, the requester tagged as you", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(
      ts,
      hello({ profile: profile({ topics: ["travel"] }) }),
      hello({ profile: profile({ topics: ["travel", "food"] }) }),
    );
    const shownA = next(ca, "spark:show");
    const shownB = next(cb, "spark:show");
    const ack = await ca.timeout(1000).emitWithAck("spark:request", { roomId });
    if (!ack.ok) throw new Error(`spark failed: ${ack.error}`);
    const [a, b] = await Promise.all([shownA, shownB]);
    expect(a).toEqual({ roomId, promptId: ack.promptId, from: "you", at: a.at });
    expect(b).toEqual({ roomId, promptId: ack.promptId, from: "partner", at: a.at });
    // A shared topic wins; prompts can carry several topics (general-12 is also travel).
    expect(SPARK_PROMPTS.find((prompt) => prompt.id === ack.promptId)?.topics).toContain("travel");
  });

  test("a second request inside the room cooldown is rate limited for either member", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const first = await ca.timeout(1000).emitWithAck("spark:request", { roomId });
    expect(first.ok).toBe(true);
    const again = await cb.timeout(1000).emitWithAck("spark:request", { roomId });
    expect(again).toEqual({ ok: false, error: "rate_limited" });
    expect(SPARK.cooldownMs).toBe(10_000);
  });

  test("a socket outside the room is rejected", async () => {
    ts = await startServer();
    const { roomId } = await activePair(ts);
    const stranger = await ts.connect();
    await sendHello(stranger, hello());
    const ack = await stranger.timeout(1000).emitWithAck("spark:request", { roomId });
    expect(ack).toEqual({ ok: false, error: "not_in_room" });
  });

  test("the metric counts prompts shown", async () => {
    ts = await startServer();
    const { ca, roomId } = await activePair(ts);
    await ca.timeout(1000).emitWithAck("spark:request", { roomId });
    const body = await ts.server.metrics.registry.metrics();
    expect(body).toMatch(/chizzy_spark_total 1/);
  });
});

describe("captions", () => {
  const segment = (roomId: string, extra: Partial<CaptionSegmentPayload> = {}): CaptionSegmentPayload => ({
    roomId,
    id: "s1",
    text: "hello there",
    final: false,
    lang: "en",
    ...extra,
  });

  test("a segment reaches the partner unchanged and never echoes to the sender", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const got = next(cb, "caption:segment");
    const echo = arrives(ca, "caption:segment");
    const payload = segment(roomId, { final: true, lang: "hi", text: "नमस्ते" });
    ca.emit("caption:segment", payload);
    expect(await got).toEqual(payload);
    expect(await echo).toBe(false);
  });

  test("only an active member of the room can send", async () => {
    ts = await startServer();
    const { cb, roomId } = await activePair(ts);
    const stranger = await ts.connect();
    await sendHello(stranger, hello());
    const got = arrives(cb, "caption:segment");
    stranger.emit("caption:segment", segment(roomId));
    expect(await got).toBe(false);
  });

  test("oversized or malformed segments are rejected before the relay", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const got = arrives(cb, "caption:segment", 500);
    const error = next(ca, "server:error");
    // 400 Devanagari characters are 1200 UTF-8 bytes: over the 1 KB cap though under 1024 characters.
    ca.emit("caption:segment", segment(roomId, { text: "क".repeat(400) }));
    expect(await error).toEqual({ code: "invalid_payload" });
    expect(await got).toBe(false);
    expect(CAPTIONS.maxBytes).toBe(1024);
  });

  test("more than CAPTIONS.maxPerSec segments in a burst are dropped", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const received: CaptionSegmentPayload[] = [];
    cb.on("caption:segment", (p) => received.push(p));
    for (let i = 0; i < CAPTIONS.maxPerSec * 2; i += 1) ca.emit("caption:segment", segment(roomId, { id: `s${i}` }));
    await delay(300);
    expect(received.length).toBe(CAPTIONS.maxPerSec);
    expect(received[0]?.id).toBe("s0");
  });

  test("contact details are hidden during the guarded window, as in chat, and pass afterwards", async () => {
    ts = await startServer({ chatGuardMs: 300 });
    const { ca, cb, roomId } = await activePair(ts);
    const text = "call me 9876543210 or insta @sneaky_handle https://evil.example";
    const hidden = next(cb, "caption:segment");
    ca.emit("caption:segment", segment(roomId, { final: true, text }));
    expect((await hidden).text).toBe("call me [hidden for safety] or [hidden for safety] [hidden for safety]");
    await delay(350);
    const shown = next(cb, "caption:segment");
    ca.emit("caption:segment", segment(roomId, { id: "s2", final: true, text }));
    expect((await shown).text).toBe(text);
  });

  test("the per-socket byte budget drops segments before the segment count cap would", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const received: CaptionSegmentPayload[] = [];
    cb.on("caption:segment", (p) => received.push(p));
    // Fewer segments than maxPerSec, but each is maxBytes: only the burst allowance (2 x maxBytesPerSec) gets through.
    const count = CAPTIONS.maxPerSec - 1;
    for (let i = 0; i < count; i += 1) ca.emit("caption:segment", segment(roomId, { id: `b${i}`, text: "x".repeat(CAPTIONS.maxBytes) }));
    await delay(300);
    expect(received.length).toBe(Math.floor((2 * CAPTIONS.maxBytesPerSec) / CAPTIONS.maxBytes));
    expect(received.length).toBeLessThan(count);
  });
});
