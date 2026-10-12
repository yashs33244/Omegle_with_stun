/**
 * Retry timing for the socket connection and POST /api/session.
 *
 * Every client that lost the server (a restart, a deploy, an overload
 * refusal) must not come back at the same instant: each delay is drawn at
 * random up to an exponential ceiling (full jitter, capped at 30 s), never
 * earlier than the server's Retry-After, and no client makes more than
 * RETRY_MAX_PER_MINUTE attempts in any 60 s, whatever triggers them.
 */

/** Ceiling of the first delay; it doubles per consecutive failure. */
export const RETRY_BASE_MS = 2_000;
/** Ceiling of any backoff delay. */
export const RETRY_MAX_MS = 30_000;
/** No delay is shorter than this, so even an unlucky draw does not retry in the same tick. */
export const RETRY_MIN_MS = 250;
/** A Retry-After longer than this is treated as this (a wrong header must not park the client for hours). */
export const RETRY_AFTER_MAX_MS = 300_000;
/** Attempts (the first connect included) allowed in any rolling RETRY_WINDOW_MS. */
export const RETRY_MAX_PER_MINUTE = 6;
export const RETRY_WINDOW_MS = 60_000;
/** Consecutive failures after which the UI says the server is busy instead of "cannot reach". */
export const BUSY_AFTER_FAILURES = 2;

/**
 * Delay before retry number `failures` (0 for the first retry): uniform in
 * [RETRY_MIN_MS, min(RETRY_MAX_MS, RETRY_BASE_MS * 2^failures)]. With a
 * Retry-After the delay is at least that long, plus up to a quarter more so
 * the clients told the same Retry-After spread out too.
 */
export function backoffDelay(failures: number, retryAfterMs: number | null = null, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 16));
  const backoff = RETRY_MIN_MS + random() * Math.max(0, ceiling - RETRY_MIN_MS);
  if (retryAfterMs === null || !(retryAfterMs > 0)) return Math.round(backoff);
  const floor = Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
  return Math.round(Math.max(backoff, floor + random() * floor * 0.25));
}

/** Retry-After as delta seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Backoff state for one retry loop: consecutive failures for the exponent,
 * and the times of recent attempts for the per-minute cap.
 */
export class Backoff {
  private failureCount = 0;
  private attempts: number[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random(),
  ) {}

  /** Consecutive failures since the last success. */
  get failures(): number {
    return this.failureCount;
  }

  /** Records an attempt made right now that was not scheduled by nextAttemptAt (the first connect). */
  noteAttempt(): void {
    this.attempts.push(this.now());
  }

  /**
   * After a failure: the local time of the next attempt, which is recorded as
   * made then. Pushed back when RETRY_MAX_PER_MINUTE attempts already fall in
   * the window ending at that time.
   */
  nextAttemptAt(retryAfterMs: number | null = null): number {
    const now = this.now();
    let at = now + backoffDelay(this.failureCount, retryAfterMs, this.random);
    this.failureCount += 1;
    this.attempts = this.attempts.filter((t) => t > now - RETRY_WINDOW_MS);
    if (this.attempts.length >= RETRY_MAX_PER_MINUTE) {
      at = Math.max(at, this.attempts[this.attempts.length - RETRY_MAX_PER_MINUTE] + RETRY_WINDOW_MS);
    }
    this.attempts.push(at);
    return at;
  }

  /** A success: the next failure starts from the shortest delay again. The per-minute history stays. */
  reset(): void {
    this.failureCount = 0;
  }
}
