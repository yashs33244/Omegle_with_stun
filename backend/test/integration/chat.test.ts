/**
 * Chat, typing, coins and friends over real sockets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { activePair, arrives, hello, next, sendHello, startServer, type TestServer } from "../helpers";

let ts: TestServer;
afterEach(async () => {
  await ts?.close();
});

describe("chat", () => {
  test("messages get a server id and timestamp and reach only the partner", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const got = next(cb, "chat:message");
    const echo = arrives(ca, "chat:message");
    const before = Date.now();
    const ack = await ca.timeout(1000).emitWithAck("chat:send", { roomId, text: "  hello <b>there</b>  " });
    if (!ack.ok) throw new Error(`chat failed: ${ack.error}`);
    expect(ack.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ack.ts).toBeGreaterThanOrEqual(before);
    expect(await got).toEqual({ roomId, id: ack.id, text: "hello <b>there</b>", ts: ack.ts, redacted: false });
    expect(await echo).toBe(false);
  });

  test("chat outside an active room is rejected", async () => {
    ts = await startServer();
    const c = await ts.connect();
    await sendHello(c, hello());
    const ack = await c.timeout(1000).emitWithAck("chat:send", { roomId: crypto.randomUUID(), text: "hi" });
    expect(ack).toEqual({ ok: false, error: "not_in_room" });
  });

  test("typing is relayed to the partner", async () => {
    ts = await startServer();
    const { ca, cb, roomId } = await activePair(ts);
    const got = next(cb, "chat:typing");
    ca.emit("chat:typing", { roomId, typing: true });
    expect(await got).toEqual({ roomId, typing: true });
  });

  test("chat is rate limited per socket", async () => {
    ts = await startServer();
    const { ca, roomId } = await activePair(ts);
    const acks = await Promise.all(
      Array.from({ length: 15 }, (_, i) => ca.timeout(1000).emitWithAck("chat:send", { roomId, text: `m${i}` })),
    );
    const limited = acks.filter((a) => !a.ok && a.error === "rate_limited").length;
    expect(limited).toBeGreaterThanOrEqual(4);
    expect(acks.filter((a) => a.ok).length).toBeGreaterThanOrEqual(10);
  });
});

describe("coins and friends", () => {
  test("active calls earn coins every interval and become friends after the threshold", async () => {
    ts = await startServer();
    const { ca, cb, a, b } = await activePair(ts);
    const coinsA = next(ca, "coins:update", 1500);
    const coinsB = next(cb, "coins:update", 1500);
    expect(await coinsA).toEqual({ balance: 105, delta: 5 });
    expect(await coinsB).toEqual({ balance: 105, delta: 5 });
    const friendsA = next(ca, "friends:new", 1500);
    const friendsB = next(cb, "friends:new", 1500);
    await Promise.all([friendsA, friendsB]);
    expect(await ts.store.areFriends(a.deviceId, b.deviceId)).toBe(true);

    // Coins persist per device and come back in the hello ack.
    ca.disconnect();
    const again = await ts.connect();
    const found = next(cb, "match:found");
    const ack = await sendHello(again, a);
    if (!ack.ok) throw new Error("hello failed");
    expect(ack.coins).toBeGreaterThanOrEqual(105);
    // The friends set is reflected in the next match.
    expect((await found).isFriend).toBe(true);
    void b;
  });

  test("coins stop when the call ends", async () => {
    ts = await startServer({ coinIntervalMs: 200 });
    const { ca } = await activePair(ts);
    ca.emit("call:skip");
    await next(ca, "match:ended");
    expect(await arrives(ca, "coins:update", 400)).toBe(false);
  });
});
