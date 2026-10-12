import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";
import { getSessionToken, onSessionInvalidated, resetSessionStateForTests, saveSession } from "@/lib/session";

type Handler = (...args: unknown[]) => void;

/** The parts of a socket.io client socket the session wiring touches. */
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  emitted: { event: string; payload: unknown; ack?: Handler }[] = [];
  connected = false;
  connect = vi.fn(() => this);
  disconnect = vi.fn(() => this);
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  onAny() {
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
  fire(event: string, ...args: unknown[]) {
    if (event === "connect") this.connected = true;
    if (event === "disconnect" || event === "connect_error") this.connected = false;
    act(() => (this.handlers.get(event) ?? []).forEach((h) => h(...args)));
  }
  hellos() {
    return this.emitted.filter((e) => e.event === "session:hello") as { payload: unknown; ack: Handler }[];
  }
  acks(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.ack as Handler);
  }
}

let socket: FakeSocket;
const ioMock = vi.fn((..._args: unknown[]) => socket);
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => ioMock(...args) }));

const { useSignaling } = await import("./useSignaling");

const profile: Profile = { name: "Ana", country: "IN", language: "en", gender: "unspecified", topics: ["music"] };
const preferences: Preferences = { genderFilter: "all", languageFilter: "any" };

const session = (token: string) => ({
  ok: true as const,
  sessionToken: token,
  sessionExpiresAt: Date.now() + 86_400_000,
  ageToken: "age",
  ageExpiresAt: Date.now() + 86_400_000,
  country: null,
});

function authOf(): Record<string, unknown> {
  const opts = ioMock.mock.calls[0]?.[1] as { auth: (cb: (data: Record<string, unknown>) => void) => void };
  let data: Record<string, unknown> = {};
  opts.auth((d) => {
    data = d;
  });
  return data;
}

describe("useSignaling session auth", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSessionStateForTests();
    socket = new FakeSocket();
    ioMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the current session token at every connection attempt", () => {
    saveSession(session("tok-1"), "v");
    renderHook(() => useSignaling(profile, preferences));
    expect(authOf()).toEqual({ sessionToken: "tok-1" });
    saveSession(session("tok-2"), "v");
    expect(authOf()).toEqual({ sessionToken: "tok-2" });
  });

  it("asks the gate for a new session on session_required and reconnects once it is saved", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    saveSession(session("old"), "v");
    const reasons: string[] = [];
    onSessionInvalidated((r) => reasons.push(r));
    const { result } = renderHook(() => useSignaling(profile, preferences));
    expect(socket.connect).toHaveBeenCalledTimes(1);

    socket.fire("connect_error", Object.assign(new Error("session_required"), { data: { code: "session_required" } }));
    expect(reasons).toEqual(["session_required"]);
    expect(getSessionToken()).toBeNull();
    expect(result.current.state.error).toBe("Cannot reach the server. Retrying...");
    // No retries with the refused token while the gate works.
    act(() => vi.advanceTimersByTime(60_000));
    expect(socket.connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      saveSession(session("new"), "v");
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(250));
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(authOf()).toEqual({ sessionToken: "new" });
  });

  it("on session_expired gets a new token from the gate and reconnects with the settings in use", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    saveSession(session("day-1"), "v");
    const reasons: string[] = [];
    onSessionInvalidated((r) => reasons.push(r));
    const { result } = renderHook(() => useSignaling(profile, preferences, { mode: "instant" }));
    socket.fire("connect");
    act(() => socket.hellos()[0].ack(null, { ok: true, coins: 5, iceServers: [], mode: "instant", genderFilter: "all" }));
    // The user changed a setting during the session.
    const changed: Preferences = { genderFilter: "all", languageFilter: "hi" };
    const saved = act(() => result.current.updatePreferences(changed));
    act(() => socket.acks("session:preferences")[0]({ ok: true }));
    await saved;

    socket.fire("server:error", { code: "session_expired", message: "Session expired" });
    socket.fire("disconnect", "io server disconnect");
    expect(reasons).toEqual(["session_expired"]);
    expect(getSessionToken()).toBeNull();
    expect(result.current.state.status).toBe("connecting");
    act(() => vi.advanceTimersByTime(30_000));
    expect(socket.connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      saveSession(session("day-2"), "v");
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(250));
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(authOf()).toEqual({ sessionToken: "day-2" });
    socket.fire("connect");
    expect(socket.hellos()[1].payload).toMatchObject({ profile, preferences: changed, mode: "instant" });
  });

  it("retries ordinary connection errors through the backoff without asking the gate", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const reasons: string[] = [];
    onSessionInvalidated((r) => reasons.push(r));
    renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect_error", new Error("websocket error"));
    expect(reasons).toEqual([]);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(250));
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });
});
