import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGE_TOKEN_KEY,
  LOCKOUT_KEY,
  SESSION_TOKEN_KEY,
  fingerprint,
  getAgeToken,
  getSessionToken,
  invalidateSession,
  isLockedOut,
  markLockedOut,
  onSessionInvalidated,
  resetSessionStateForTests,
  saveSession,
  waitForSession,
  type SessionOk,
} from "./session";

const NOW = 1_800_000_000_000;

function ok(overrides: Partial<SessionOk> = {}): SessionOk {
  return {
    ok: true,
    sessionToken: "session-1",
    sessionExpiresAt: NOW + 24 * 3600_000,
    ageToken: "age-1",
    ageExpiresAt: NOW + 180 * 86_400_000,
    country: "IN",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetSessionStateForTests();
});

describe("session storage", () => {
  it("stores both tokens and returns them while valid", () => {
    saveSession(ok(), "v1");
    expect(getSessionToken(NOW)).toBe("session-1");
    expect(getAgeToken("v1", NOW)).toBe("age-1");
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toContain("session-1");
    // Never the date of birth: only tokens and their expiry are kept.
    expect(localStorage.getItem(AGE_TOKEN_KEY)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("treats tokens close to expiry as expired", () => {
    saveSession(ok({ sessionExpiresAt: NOW + 30_000 }), "v1");
    expect(getSessionToken(NOW)).toBeNull();
    expect(getAgeToken("v1", NOW)).toBe("age-1");
  });

  it("drops the age token when the Terms version changed", () => {
    saveSession(ok(), "v1");
    expect(getAgeToken("v2", NOW)).toBeNull();
  });

  it("ignores corrupt entries", () => {
    localStorage.setItem(SESSION_TOKEN_KEY, "{not json");
    expect(getSessionToken(NOW)).toBeNull();
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("locks the device out and forgets its tokens", () => {
    saveSession(ok(), "v1");
    markLockedOut(NOW);
    expect(isLockedOut()).toBe(true);
    expect(getSessionToken(NOW)).toBeNull();
    expect(getAgeToken("v1", NOW)).toBeNull();
    expect(JSON.parse(localStorage.getItem(LOCKOUT_KEY) ?? "{}")).toEqual({ at: NOW });
  });

  it("works from memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    saveSession(ok(), "v1");
    expect(getSessionToken(NOW)).toBe("session-1");
  });
});

describe("session invalidation", () => {
  it("clears the token, notifies the gate and resolves waiters with the next session", async () => {
    saveSession(ok(), "v1");
    const reasons: string[] = [];
    const off = onSessionInvalidated((r) => reasons.push(r));
    const next = waitForSession();

    invalidateSession("session_required");
    expect(reasons).toEqual(["session_required"]);
    expect(getSessionToken(NOW)).toBeNull();

    saveSession(ok({ sessionToken: "session-2" }), "v1");
    await expect(next).resolves.toBe("session-2");
    off();
    invalidateSession();
    expect(reasons).toHaveLength(1);
  });
});

describe("fingerprint", () => {
  it("is a stable SHA-256 hex of the coarse traits", async () => {
    const traits = {
      userAgent: "UA",
      language: "en-IN",
      timezone: "Asia/Kolkata",
      screen: "1280x800",
      hardwareConcurrency: 8,
    };
    const a = await fingerprint(traits);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await fingerprint(traits)).toBe(a);
    expect(await fingerprint({ ...traits, screen: "390x844" })).not.toBe(a);
  });
});
