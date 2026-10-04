import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Preferences, Profile } from "@/lib/protocol";
import { getSessionToken, onSessionInvalidated, resetSessionStateForTests, saveSession } from "@/lib/session";

type Handler = (...args: unknown[]) => void;

/** The parts of a socket.io client socket the session wiring touches. */
class FakeSocket {
  handlers = new Map<string, Handler[]>();
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
  emit() {
    return this;
  }
  timeout() {
    return { emit: () => this };
  }
  fire(event: string, ...args: unknown[]) {
    act(() => (this.handlers.get(event) ?? []).forEach((h) => h(...args)));
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

  it("sends the current session token at every connection attempt", () => {
    saveSession(session("tok-1"), "v");
    renderHook(() => useSignaling(profile, preferences));
    expect(authOf()).toEqual({ sessionToken: "tok-1" });
    saveSession(session("tok-2"), "v");
    expect(authOf()).toEqual({ sessionToken: "tok-2" });
  });

  it("asks the gate for a new session on session_required and reconnects once it is saved", async () => {
    saveSession(session("old"), "v");
    const reasons: string[] = [];
    onSessionInvalidated((r) => reasons.push(r));
    const { result } = renderHook(() => useSignaling(profile, preferences));
    expect(socket.connect).toHaveBeenCalledTimes(1);

    socket.fire("connect_error", Object.assign(new Error("session_required"), { data: { code: "session_required" } }));
    expect(reasons).toEqual(["session_required"]);
    expect(getSessionToken()).toBeNull();
    expect(result.current.state.error).toBe("Cannot reach the server. Retrying...");

    await act(async () => {
      saveSession(session("new"), "v");
      await Promise.resolve();
    });
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(authOf()).toEqual({ sessionToken: "new" });
  });

  it("leaves ordinary connection errors to socket.io's own retries", () => {
    const reasons: string[] = [];
    onSessionInvalidated((r) => reasons.push(r));
    renderHook(() => useSignaling(profile, preferences));
    socket.fire("connect_error", new Error("xhr poll error"));
    expect(reasons).toEqual([]);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });
});
