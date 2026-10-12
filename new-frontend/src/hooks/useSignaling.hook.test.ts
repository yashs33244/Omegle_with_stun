import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";

type Handler = (...args: unknown[]) => void;

/** Just enough of a socket.io client socket for the hook. */
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  anyHandlers: Handler[] = [];
  emitted: { event: string; payload: unknown; ack?: Handler }[] = [];
  connected = false;
  connect = vi.fn(() => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
    return this;
  });
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  onAny(handler: Handler) {
    this.anyHandlers.push(handler);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  emit(event: string, payload?: unknown, ack?: Handler) {
    this.emitted.push({ event, payload, ack });
    return this;
  }
  timeout() {
    return {
      emit: (event: string, payload: unknown, ack: Handler) => this.emit(event, payload, ack),
      emitWithAck: (event: string, payload: unknown) =>
        new Promise((resolve) => this.emit(event, payload, (res: unknown) => resolve(res))),
    };
  }
  /** Simulate a server -> client event. */
  fire(event: string, ...args: unknown[]) {
    if (event === "disconnect" || event === "connect_error") this.connected = false;
    if (event === "connect") this.connected = true;
    act(() => {
      (this.handlers.get(event) ?? []).forEach((h) => h(...args));
      this.anyHandlers.forEach((h) => h(event, ...args));
    });
  }
  hellos() {
    return this.emitted.filter((e) => e.event === "session:hello");
  }
}

let socket: FakeSocket;
const ioMock = vi.fn((..._args: unknown[]) => socket);
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => ioMock(...args) }));

const { useSignaling } = await import("./useSignaling");

const profile: Profile = { name: "Ana", country: "IN", language: "en", gender: "unspecified", topics: ["music"] };
const preferences: Preferences = { genderFilter: "all", languageFilter: "any" };

describe("useSignaling (socket wiring)", () => {
  beforeEach(() => {
    socket = new FakeSocket();
    ioMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("connects with the websocket transport only", () => {
    renderHook(() => useSignaling(profile, preferences));
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock.mock.calls[0][1]).toMatchObject({ transports: ["websocket"] });
    expect(socket.connect).toHaveBeenCalled();
  });

  it("sends a valid session:hello on every connect, including reconnects", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    expect(socket.hellos()).toHaveLength(1);
    expect(socket.hellos()[0].payload).toMatchObject({ protocolVersion: 3, profile, preferences, mode: "preview" });

    act(() => socket.hellos()[0].ack?.(null, { ok: true, coins: 120, iceServers: [], mode: "preview", genderFilter: "all" }));
    expect(result.current.state.status).toBe("waiting");
    expect(result.current.state.coins).toBe(120);

    socket.fire("disconnect", "transport close");
    expect(result.current.state.status).toBe("connecting");
    expect(result.current.state.reconnecting).toBe(true);

    socket.fire("connect");
    expect(socket.hellos()).toHaveLength(2);
    expect(socket.hellos()[1].payload).toEqual(socket.hellos()[0].payload);
  });

  it("sends the requested match mode in hello", () => {
    renderHook(() => useSignaling(profile, preferences, { mode: "instant" }));
    socket.fire("connect");
    expect(socket.hellos()[0].payload).toMatchObject({ mode: "instant" });
  });

  it("accepts an instant-mode match by itself and keeps the call:start media", () => {
    const roomId = "00000000-0000-4000-8000-000000000001";
    const { result } = renderHook(() => useSignaling(profile, preferences, { mode: "instant" }));
    socket.fire("connect");
    const match = { roomId, partner: { ...profile, gender: undefined }, isFriend: false, expiresAt: 2, serverNow: 1, sharedTopics: [] };
    socket.fire("match:found", { ...match, mode: "instant" });
    expect(socket.emitted.filter((e) => e.event === "match:accept")).toEqual([{ event: "match:accept", payload: { roomId }, ack: undefined }]);
    expect(result.current.state.status).toBe("starting-call");
    expect(result.current.state.matchMode).toBe("instant");

    const media = { iceServers: [{ urls: "turn:t", username: "u", credential: "c" }], maxBitrateKbps: 900, relayMaxBitrateKbps: 500, privateModeAllowed: true };
    socket.fire("call:start", { roomId, initiator: true, ...media });
    expect(result.current.state.status).toBe("in-call");
    expect(result.current.state.callMedia).toEqual(media);
  });

  it("leaves a preview-mode match to the user", () => {
    renderHook(() => useSignaling(profile, preferences, { mode: "preview" }));
    socket.fire("connect");
    socket.fire("match:found", {
      roomId: "00000000-0000-4000-8000-000000000002",
      partner: profile,
      isFriend: false,
      expiresAt: 2,
      serverNow: 1,
      sharedTopics: [],
      mode: "preview",
    });
    expect(socket.emitted.some((e) => e.event === "match:accept")).toBe(false);
  });

  it("subscribe() receives server events across reconnects until unsubscribed", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    const seen: unknown[] = [];
    let off = () => {};
    act(() => {
      off = result.current.subscribe("safety:nudge", (p) => seen.push(p));
    });
    socket.fire("connect");
    socket.fire("safety:nudge", { roomId: "r1", kind: "contact-sharing" });
    socket.fire("disconnect", "transport close");
    socket.fire("connect");
    socket.fire("safety:nudge", { roomId: "r1", kind: "link-hidden" });
    act(() => off());
    socket.fire("safety:nudge", { roomId: "r1", kind: "solicitation" });
    expect(seen).toEqual([
      { roomId: "r1", kind: "contact-sharing" },
      { roomId: "r1", kind: "link-hidden" },
    ]);
  });

  it("send() emits extra client events only while connected", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.connected = false;
    act(() => result.current.send("moderation:signal", { roomId: "00000000-0000-4000-8000-000000000000", kind: "no-face" }));
    expect(socket.emitted.some((e) => e.event === "moderation:signal")).toBe(false);
    socket.connected = true;
    socket.fire("connect");
    act(() => result.current.send("moderation:signal", { roomId: "00000000-0000-4000-8000-000000000000", kind: "no-face" }));
    expect(socket.emitted.filter((e) => e.event === "moderation:signal")).toHaveLength(1);
  });

  it("reconnects after a jittered delay after a server-initiated disconnect, not at once", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    socket.connect.mockClear();
    socket.fire("disconnect", "io server disconnect");
    expect(socket.connect).not.toHaveBeenCalled();
    // 250 ms + 0.5 * (2000 - 250) ms.
    act(() => vi.advanceTimersByTime(1_124));
    expect(socket.connect).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it("brings clients dropped together back at different times", () => {
    vi.useFakeTimers();
    // Each client draws its own delay: the first one to drop draws 0.05, the second 0.95.
    vi.spyOn(Math, "random").mockReturnValueOnce(0.05).mockReturnValueOnce(0.95);
    const sockets = [new FakeSocket(), new FakeSocket()];
    const reconnectedAt: number[] = [];
    sockets.forEach((s, i) => {
      socket = s;
      renderHook(() => useSignaling(profile, preferences));
      s.fire("connect");
      s.connect.mockImplementation(() => {
        reconnectedAt[i] = Date.now();
        return s;
      });
    });
    const start = Date.now();
    sockets.forEach((s) => s.fire("disconnect", "transport close"));
    act(() => vi.advanceTimersByTime(2_000));
    expect(reconnectedAt.map((t) => t - start)).toEqual([338, 1913]);
  });

  it("caps connection attempts at 6 per minute while the server keeps refusing", () => {
    vi.useFakeTimers();
    // The shortest delay every time: only the cap holds the client back.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const start = Date.now();
    const attempts = [0];
    renderHook(() => useSignaling(profile, preferences));
    socket.connect.mockImplementation(() => {
      attempts.push(Date.now() - start);
      // An upgrade refused with 503 reaches the client as a plain websocket error.
      socket.fire("connect_error", new Error("websocket error"));
      return socket;
    });
    socket.fire("connect_error", new Error("websocket error"));
    act(() => vi.advanceTimersByTime(119_000));
    // Without the cap: one attempt every 250 ms.
    expect(attempts).toEqual([0, 250, 500, 750, 1_000, 1_250, 60_000, 60_250, 60_500, 60_750, 61_000, 61_250]);
  });

  it("says the server is busy from the second failure in a row until a hello succeeds", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect_error", new Error("websocket error"));
    expect(result.current.state.busyRetryAt).toBeNull();
    expect(result.current.state.error).toBe("Cannot reach the server. Retrying...");
    act(() => vi.advanceTimersByTime(250));
    socket.fire("connect_error", new Error("websocket error"));
    expect(result.current.state.busyRetryAt).toBe(Date.now() + 250);

    act(() => vi.advanceTimersByTime(250));
    socket.fire("connect");
    expect(result.current.state.busyRetryAt).toBeNull();
    act(() => socket.hellos()[0].ack?.(null, { ok: true, coins: 1, iceServers: [], mode: "preview", genderFilter: "all" }));
    expect(result.current.state.status).toBe("waiting");
  });

  it("does not reconnect after the session was replaced", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    socket.connect.mockClear();
    socket.fire("session:replaced");
    socket.fire("disconnect", "io server disconnect");
    expect(result.current.state.status).toBe("replaced");
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("does not reconnect after a banned hello", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    socket.connect.mockClear();
    act(() => socket.hellos()[0].ack?.(null, { ok: false, error: "banned" }));
    socket.fire("disconnect", "io server disconnect");
    expect(result.current.state.status).toBe("banned");
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("ignores a late hello ack from a previous connection", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    const stale = socket.hellos()[0];
    socket.fire("disconnect", "transport close");
    socket.fire("connect");
    act(() => stale.ack?.(null, { ok: false, error: "internal" }));
    expect(result.current.state.status).toBe("connecting");
  });

  it("replays rtc signals that arrived before the peer connection subscribed", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    const room = "11111111-1111-4111-8111-111111111111";
    socket.fire("connect");
    const offer = { roomId: room, description: { type: "offer", sdp: "x" } };
    socket.fire("rtc:signal", offer);
    const listener = vi.fn();
    act(() => {
      result.current.subscribeSignals(room, listener);
    });
    expect(listener).toHaveBeenCalledWith(offer);
  });

  it("report() targets the given room even after the call ended", async () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    const ended = "00000000-0000-4000-8000-0000000000aa";
    let ack: unknown;
    await act(async () => {
      const pending = result.current.report("nudity", "details", { chat: [] }, ended);
      const sent = socket.emitted.find((e) => e.event === "report:submit");
      sent?.ack?.({ ok: true, reportId: "r1" });
      ack = await pending;
    });
    const sent = socket.emitted.find((e) => e.event === "report:submit");
    expect(sent?.payload).toEqual({ roomId: ended, reason: "nudity", details: "details", evidence: { chat: [] } });
    expect(ack).toEqual({ ok: true, reportId: "r1" });
  });

  it("does not send an accept once the match countdown has run out", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSignaling(profile, preferences));
      const room = "11111111-1111-4111-8111-111111111111";
      socket.connected = true;
      socket.fire("connect");
      const serverNow = Date.now();
      socket.fire("match:found", {
        roomId: room,
        isFriend: false,
        expiresAt: serverNow + 30_000,
        serverNow,
        partner: { name: "Bo", country: "IN", language: "en", topics: ["music"] },
      });
      vi.advanceTimersByTime(30_000);
      act(() => result.current.accept());
      expect(socket.emitted.some((e) => e.event === "match:accept")).toBe(false);
      expect(result.current.state.status).toBe("match-found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends an accept while the match countdown is running", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    const room = "11111111-1111-4111-8111-111111111111";
    socket.connected = true;
    socket.fire("connect");
    const serverNow = Date.now();
    socket.fire("match:found", {
      roomId: room,
      isFriend: false,
      expiresAt: serverNow + 30_000,
      serverNow,
      partner: { name: "Bo", country: "IN", language: "en", topics: ["music"] },
    });
    act(() => result.current.accept());
    expect(socket.emitted.filter((e) => e.event === "match:accept")).toEqual([
      { event: "match:accept", payload: { roomId: room }, ack: undefined },
    ]);
    expect(result.current.state.status).toBe("starting-call");
  });

  it("reports the peer connection once per call, and only during a call", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    const room = "11111111-1111-4111-8111-111111111111";
    socket.connected = true;
    socket.fire("connect");
    const connectedReports = () => socket.emitted.filter((e) => e.event === "call:connected");
    act(() => result.current.reportConnected());
    expect(connectedReports()).toHaveLength(0);

    const serverNow = Date.now();
    socket.fire("match:found", {
      roomId: room,
      isFriend: false,
      expiresAt: serverNow + 30_000,
      serverNow,
      partner: { name: "Bo", country: "IN", language: "en", topics: ["music"] },
    });
    act(() => result.current.accept());
    socket.fire("call:start", { roomId: room, initiator: true });
    act(() => result.current.reportConnected());
    act(() => result.current.reportConnected());
    expect(connectedReports()).toEqual([{ event: "call:connected", payload: { roomId: room }, ack: undefined }]);
  });

  it("sends one skip per call, and only during a call", () => {
    const { result } = renderHook(() => useSignaling(profile, preferences));
    const room = "11111111-1111-4111-8111-111111111111";
    const next = "22222222-2222-4222-8222-222222222222";
    socket.connected = true;
    socket.fire("connect");
    const skips = () => socket.emitted.filter((e) => e.event === "call:skip");
    const startCall = (roomId: string) => {
      const serverNow = Date.now();
      socket.fire("match:found", {
        roomId,
        isFriend: false,
        expiresAt: serverNow + 30_000,
        serverNow,
        partner: { name: "Bo", country: "IN", language: "en", topics: ["music"] },
      });
      act(() => result.current.accept());
      socket.fire("call:start", { roomId, initiator: true });
    };

    act(() => result.current.skip());
    expect(skips()).toHaveLength(0);

    startCall(room);
    // A double click, or the overlay button racing the auto-skip timer.
    act(() => result.current.skip());
    act(() => result.current.skip());
    expect(skips()).toHaveLength(1);

    // After match:ended the user is waiting: a late click must not skip the next match.
    socket.fire("match:ended", { roomId: room, reason: "skipped" });
    act(() => result.current.skip());
    expect(skips()).toHaveLength(1);

    // A later call can be skipped again.
    startCall(next);
    act(() => result.current.skip());
    expect(skips()).toHaveLength(2);
  });

  it("disconnects on unmount", () => {
    const { unmount } = renderHook(() => useSignaling(profile, preferences));
    unmount();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
