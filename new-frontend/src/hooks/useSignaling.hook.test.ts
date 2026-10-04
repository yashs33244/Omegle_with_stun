import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";

type Handler = (...args: unknown[]) => void;

/** Just enough of a socket.io client socket for the hook. */
class FakeSocket {
  handlers = new Map<string, Handler[]>();
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
    act(() => {
      (this.handlers.get(event) ?? []).forEach((h) => h(...args));
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
    expect(socket.hellos()[0].payload).toMatchObject({ protocolVersion: 2, profile, preferences });

    act(() => socket.hellos()[0].ack?.(null, { ok: true, coins: 120, iceServers: [] }));
    expect(result.current.state.status).toBe("waiting");
    expect(result.current.state.coins).toBe(120);

    socket.fire("disconnect", "transport close");
    expect(result.current.state.status).toBe("connecting");
    expect(result.current.state.reconnecting).toBe(true);

    socket.fire("connect");
    expect(socket.hellos()).toHaveLength(2);
    expect(socket.hellos()[1].payload).toEqual(socket.hellos()[0].payload);
  });

  it("reconnects by itself after a server-initiated disconnect", () => {
    renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect");
    socket.connect.mockClear();
    socket.fire("disconnect", "io server disconnect");
    expect(socket.connect).toHaveBeenCalledTimes(1);
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

  it("disconnects on unmount", () => {
    const { unmount } = renderHook(() => useSignaling(profile, preferences));
    unmount();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
