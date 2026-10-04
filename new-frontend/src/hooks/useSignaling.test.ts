import { describe, expect, it } from "vitest";
import {
  FRIENDS_MESSAGE,
  initialSignalingState,
  secondsLeft,
  signalingReducer,
  toLocalDeadline,
  type SignalingEvent,
  type SignalingState,
} from "./useSignaling";
import type { PublicProfile } from "@/lib/protocol";

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";

const partner: PublicProfile = {
  name: "Sam",
  country: "IN",
  language: "en",
  topics: ["music"],
};

function run(events: SignalingEvent[], from: SignalingState = initialSignalingState): SignalingState {
  return events.reduce(signalingReducer, from);
}

const hello: SignalingEvent = { type: "hello-ok", coins: 100, iceServers: [{ urls: "stun:x" }] };
const found: SignalingEvent = {
  type: "match-found",
  roomId: ROOM,
  partner,
  isFriend: false,
  expiresAt: 20_000,
  serverNow: 15_000,
  receivedAt: 1_000,
};
const start: SignalingEvent = { type: "call-start", roomId: ROOM, initiator: true, at: 2_000 };

describe("signalingReducer", () => {
  it("starts connecting and moves to waiting on a successful hello", () => {
    expect(initialSignalingState.status).toBe("connecting");
    const s = run([hello]);
    expect(s.status).toBe("waiting");
    expect(s.coins).toBe(100);
    expect(s.iceServers).toEqual([{ urls: "stun:x" }]);
  });

  it("does not knock a match back to waiting when the hello ack arrives late", () => {
    const s = run([found, hello]);
    expect(s.status).toBe("match-found");
    expect(s.coins).toBe(100);
  });

  it("walks the happy path: match, accept, partner accepts, call starts", () => {
    let s = run([hello, found]);
    expect(s.status).toBe("match-found");
    expect(s.roomId).toBe(ROOM);
    expect(s.partner).toEqual(partner);
    // expiresAt is corrected into the local clock: 5 s after local receipt.
    expect(s.expiresAt).toBe(6_000);

    s = run([{ type: "local-accept" }], s);
    expect(s.status).toBe("starting-call");

    s = run([{ type: "partner-accepted", roomId: ROOM }], s);
    expect(s.partnerAccepted).toBe(true);

    s = run([start], s);
    expect(s.status).toBe("in-call");
    expect(s.initiator).toBe(true);
    expect(s.callStartedAt).toBe(2_000);
    expect(s.expiresAt).toBeNull();
  });

  it("accepts call:start straight from match-found (partner accepted first, we accepted in the same tick)", () => {
    const s = run([hello, found, start]);
    expect(s.status).toBe("in-call");
  });

  it("ignores events for another room", () => {
    const base = run([hello, found]);
    expect(run([{ type: "partner-accepted", roomId: OTHER_ROOM }], base)).toBe(base);
    expect(run([{ type: "call-start", roomId: OTHER_ROOM, initiator: false, at: 1 }], base)).toBe(base);
    expect(run([{ type: "match-ended", roomId: OTHER_ROOM, reason: "timeout" }], base)).toBe(base);
  });

  it("local accept outside match-found is a no-op", () => {
    const s = run([hello]);
    expect(run([{ type: "local-accept" }], s)).toBe(s);
  });

  it("match end clears the room, records the reason and returns to waiting", () => {
    const inCall = run([hello, found, start, { type: "chat-received", roomId: ROOM, id: "m1", text: "hi", ts: 5 }]);
    const s = run([{ type: "match-ended", roomId: ROOM, reason: "partner-skipped" }], inCall);
    expect(s.status).toBe("waiting");
    expect(s.lastEndReason).toBe("partner-skipped");
    expect(s.roomId).toBeNull();
    expect(s.partner).toBeNull();
    expect(s.initiator).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.coins).toBe(100);
  });

  it("a new match clears the previous end reason", () => {
    const ended = run([hello, found, { type: "match-ended", roomId: ROOM, reason: "timeout" }]);
    expect(ended.lastEndReason).toBe("timeout");
    expect(run([found], ended).lastEndReason).toBeNull();
  });

  it("socket disconnect ends the call and shows reconnecting; the next hello re-queues", () => {
    const inCall = run([hello, found, start]);
    let s = run([{ type: "socket-disconnected" }], inCall);
    expect(s.status).toBe("connecting");
    expect(s.reconnecting).toBe(true);
    expect(s.roomId).toBeNull();
    s = run([hello], s);
    expect(s.status).toBe("waiting");
    expect(s.reconnecting).toBe(false);
  });

  it("banned hello is terminal", () => {
    const s = run([{ type: "hello-failed", error: "banned" }]);
    expect(s.status).toBe("banned");
    expect(run([{ type: "socket-disconnected" }, hello, found], s)).toBe(s);
  });

  it("server:error banned ends the call and is terminal", () => {
    const s = run([hello, found, start, { type: "server-error", code: "banned" }]);
    expect(s.status).toBe("banned");
    expect(s.roomId).toBeNull();
  });

  it("other server errors become a transient notice", () => {
    let s = run([hello, { type: "server-error", code: "rate_limited" }]);
    expect(s.status).toBe("waiting");
    expect(s.notice).toBe("rate_limited");
    s = run([{ type: "notice-cleared" }], s);
    expect(s.notice).toBeNull();
  });

  it("session replaced is terminal", () => {
    const s = run([hello, found, start, { type: "session-replaced" }]);
    expect(s.status).toBe("replaced");
    expect(run([hello], s)).toBe(s);
  });

  it("other hello failures show an error that a later hello clears", () => {
    let s = run([{ type: "hello-failed", error: "timeout", message: "The server did not answer" }]);
    expect(s.status).toBe("error");
    expect(s.error).toBe("The server did not answer");
    s = run([hello], s);
    expect(s.status).toBe("waiting");
    expect(s.error).toBeNull();
  });

  it("chat: optimistic local message, then the server id and time on ack", () => {
    let s = run([hello, found, start]);
    s = run([{ type: "chat-local", roomId: ROOM, tempId: "t1", text: "hello", ts: 10 }], s);
    expect(s.messages).toEqual([{ id: "t1", from: "me", text: "hello", ts: 10, delivery: "pending" }]);
    s = run([{ type: "chat-ack", tempId: "t1", ok: true, id: "srv-1", ts: 11 }], s);
    expect(s.messages).toEqual([{ id: "srv-1", from: "me", text: "hello", ts: 11, delivery: "sent" }]);
  });

  it("chat: failed ack marks the message failed", () => {
    let s = run([hello, found, start, { type: "chat-local", roomId: ROOM, tempId: "t1", text: "x", ts: 1 }]);
    s = run([{ type: "chat-ack", tempId: "t1", ok: false }], s);
    expect(s.messages[0].delivery).toBe("failed");
  });

  it("chat: messages outside a call are dropped", () => {
    const s = run([hello, found]);
    expect(run([{ type: "chat-received", roomId: ROOM, id: "m", text: "x", ts: 1 }], s)).toBe(s);
  });

  it("partner typing shows, then clears on a message or expiry", () => {
    let s = run([hello, found, start, { type: "partner-typing", roomId: ROOM, typing: true }]);
    expect(s.partnerTyping).toBe(true);
    s = run([{ type: "chat-received", roomId: ROOM, id: "m", text: "x", ts: 1 }], s);
    expect(s.partnerTyping).toBe(false);
    s = run([{ type: "partner-typing", roomId: ROOM, typing: true }, { type: "partner-typing-expired" }], s);
    expect(s.partnerTyping).toBe(false);
  });

  it("coins come from the server only and bump on positive deltas", () => {
    let s = run([hello, { type: "coins", balance: 105, delta: 5 }]);
    expect(s.coins).toBe(105);
    expect(s.coinBump).toBe(1);
    s = run([{ type: "coins", balance: 100, delta: -5 }], s);
    expect(s.coins).toBe(100);
    expect(s.coinBump).toBe(1);
  });

  it("friends: from match:found and from friends:new (once, with a system message)", () => {
    const friendly = run([hello, { ...found, isFriend: true } as SignalingEvent]);
    expect(friendly.isFriend).toBe(true);

    let s = run([hello, found, start, { type: "friends-new", roomId: ROOM }]);
    expect(s.isFriend).toBe(true);
    expect(s.messages.filter((m) => m.from === "system").map((m) => m.text)).toEqual([FRIENDS_MESSAGE]);
    s = run([{ type: "friends-new", roomId: ROOM }], s);
    expect(s.messages).toHaveLength(1);
  });

  it("queue:waiting resets any room state", () => {
    const s = run([hello, found, { type: "queue-waiting" }]);
    expect(s.status).toBe("waiting");
    expect(s.roomId).toBeNull();
  });
});

describe("countdown helpers", () => {
  it("corrects for a server clock that runs ahead", () => {
    // Server is 1 h ahead; the deadline is still 5 s from local receipt.
    expect(toLocalDeadline(3_600_000 + 5_000, 3_600_000, 0)).toBe(5_000);
  });

  it("rounds up and never goes negative", () => {
    expect(secondsLeft(5_000, 0)).toBe(5);
    expect(secondsLeft(5_000, 100)).toBe(5);
    expect(secondsLeft(5_000, 4_001)).toBe(1);
    expect(secondsLeft(5_000, 5_000)).toBe(0);
    expect(secondsLeft(5_000, 9_000)).toBe(0);
  });
});
