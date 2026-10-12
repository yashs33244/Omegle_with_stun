/**
 * Client side of the session gate (POST /api/session).
 *
 * Kept in localStorage:
 * - the age token (180 days): proof of the server's 18+ outcome, never the date of birth;
 * - the session token (24 h): passed as Socket.IO auth;
 * - an under-18 lockout marker, so a locked device does not see the form again.
 *
 * When the socket handshake rejects the token, or the server says
 * `session_expired` on a live socket, useSignaling calls invalidateSession()
 * with that reason; the gate mints a fresh one (silently for an expired
 * session when it can) and waitForSession() resolves once it is saved.
 */
import type { SessionResponse } from "@/lib/protocol";

export const AGE_TOKEN_KEY = "chizzy:ageToken";
export const SESSION_TOKEN_KEY = "chizzy:sessionToken";
export const LOCKOUT_KEY = "chizzy:lockout";

/** Treat a token as expired a little early, so it does not lapse mid-handshake. */
const EXPIRY_MARGIN_MS = 60_000;

interface StoredToken {
  token: string;
  expiresAt: number;
}

interface StoredAgeToken extends StoredToken {
  tosVersion: string;
}

export type SessionOk = Extract<SessionResponse, { ok: true }>;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** In-memory copies, used when localStorage is unavailable (private mode, blocked storage). */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    const value = storage()?.getItem(key);
    if (value != null) return value;
  } catch {
    // fall through to memory
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // memory copy is enough for this page
  }
}

function readJson<T>(key: string, valid: (v: Record<string, unknown>) => boolean): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && valid(parsed as Record<string, unknown>)) return parsed as T;
  } catch {
    // corrupt entry
  }
  write(key, null);
  return null;
}

const isToken = (v: Record<string, unknown>) => typeof v.token === "string" && typeof v.expiresAt === "number";

/** The stored age token, if it is still valid for this Terms version. */
export function getAgeToken(tosVersion: string, now = Date.now()): string | null {
  const stored = readJson<StoredAgeToken>(AGE_TOKEN_KEY, (v) => isToken(v) && typeof v.tosVersion === "string");
  if (!stored || stored.tosVersion !== tosVersion || stored.expiresAt <= now + EXPIRY_MARGIN_MS) return null;
  return stored.token;
}

/** The stored session token, if it has not expired. */
export function getSessionToken(now = Date.now()): string | null {
  const stored = readJson<StoredToken>(SESSION_TOKEN_KEY, isToken);
  if (!stored || stored.expiresAt <= now + EXPIRY_MARGIN_MS) return null;
  return stored.token;
}

type Waiter = (token: string) => void;
type InvalidationListener = (reason: string) => void;

let waiters: Waiter[] = [];
const invalidationListeners = new Set<InvalidationListener>();

/** Stores the tokens from a successful POST /api/session and wakes anyone waiting for a session. */
export function saveSession(res: SessionOk, tosVersion: string): void {
  write(SESSION_TOKEN_KEY, JSON.stringify({ token: res.sessionToken, expiresAt: res.sessionExpiresAt }));
  write(AGE_TOKEN_KEY, JSON.stringify({ token: res.ageToken, expiresAt: res.ageExpiresAt, tosVersion }));
  write(LOCKOUT_KEY, null);
  const pending = waiters;
  waiters = [];
  pending.forEach((resolve) => resolve(res.sessionToken));
}

export function clearSessionToken(): void {
  write(SESSION_TOKEN_KEY, null);
}

/** The server no longer accepts the age token: the date of birth must be asked again. */
export function clearAgeToken(): void {
  write(AGE_TOKEN_KEY, null);
}

/**
 * The server rejected the session (handshake error). Drops the token and tells
 * the gate, which asks for a new one.
 */
export function invalidateSession(reason = "session_required"): void {
  clearSessionToken();
  invalidationListeners.forEach((listener) => listener(reason));
}

export function onSessionInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/** Resolves with the next session token that gets saved. */
export function waitForSession(): Promise<string> {
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** Under-18 lockout: the server keeps its own record; this only spares the user a form that cannot pass. */
export function markLockedOut(now = Date.now()): void {
  write(LOCKOUT_KEY, JSON.stringify({ at: now }));
  clearSessionToken();
  clearAgeToken();
}

export function isLockedOut(): boolean {
  return readJson<{ at: number }>(LOCKOUT_KEY, (v) => typeof v.at === "number") !== null;
}

/** Test helper. */
export function resetSessionStateForTests(): void {
  memory.clear();
  waiters = [];
  invalidationListeners.clear();
}

/* ------------------------------------------------------------------ */
/* Fingerprint                                                         */
/* ------------------------------------------------------------------ */

/** Coarse browser traits. Many people share them; the hash is only one signal next to the device id. */
export interface FingerprintTraits {
  userAgent: string;
  language: string;
  timezone: string;
  screen: string;
  hardwareConcurrency: number;
}

export function collectTraits(): FingerprintTraits {
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    timezone = "";
  }
  return {
    userAgent: navigator.userAgent,
    language: navigator.language ?? "",
    timezone,
    screen: typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : "",
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
  };
}

/** SHA-256 hex of the traits, in a fixed field order. */
export async function fingerprint(traits: FingerprintTraits = collectTraits()): Promise<string> {
  const text = [traits.userAgent, traits.language, traits.timezone, traits.screen, String(traits.hardwareConcurrency)].join(
    "\n",
  );
  if (!crypto?.subtle) throw new Error("Secure context required");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
