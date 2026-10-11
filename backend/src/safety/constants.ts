/**
 * Named values for the safety module: the chat and name guard (guard.ts) and
 * the soft abuse signals (signals.ts). Phrase lists are data and live in
 * phrases.ts. Env-driven values stay in config.ts (earlySkipMs,
 * earlySkipMinCalls, earlySkipShare, riskThreshold, lowPriorityMs).
 */
import type { ModerationSignalPayload } from "../protocol";

/* ------------------------------------------------------------------ */
/* Chat and name guard (guard.ts)                                      */
/* ------------------------------------------------------------------ */

/** Replacement for a redacted span. The client shows it verbatim. */
export const HIDDEN = "[hidden for safety]";
/** Spans found in text: contact (handles, phones, messaging apps, social links) or link (other URLs). */
export const SPAN_KIND = { contact: "contact", link: "link" } as const;
/** Digit counts that look like a phone number (national to E.164 with country code). */
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;
/** Handle lengths accepted after a platform word or "@". */
export const HANDLE_MIN_CHARS = 2;
export const HANDLE_MAX_CHARS = 30;
/** Connector words allowed between a platform word and its handle ("my insta is priya"). */
export const MAX_CONNECTOR_TOKENS = 3;
/** Slurs at least this long are also matched inside squashed text ("r a p i s t"); shorter ones only as whole words. */
export const SQUASHED_SLUR_MIN_CHARS = 5;
/** Generated nickname: "Stranger <NICKNAME_MIN .. NICKNAME_MIN + NICKNAME_RANGE - 1>". */
export const NICKNAME_PREFIX = "Stranger ";
export const NICKNAME_MIN = 1000;
export const NICKNAME_RANGE = 9000;
/** Domain separator for the nickname hash. */
export const NICKNAME_DOMAIN = "chizzy-nick:";

/* ------------------------------------------------------------------ */
/* Abuse signals (signals.ts)                                          */
/* ------------------------------------------------------------------ */

/** Risk points expire this long (ms) after the last point. */
export const RISK_WINDOW_MS = 24 * 60 * 60_000;
/** Per-device call and early-skip counts live this long (ms), refreshed on write. */
export const CALLS_TTL_MS = 7 * 24 * 60 * 60_000;
/** Match passes reuse the low-priority set for this long (ms). */
export const LOW_PRIORITY_CACHE_MS = 1_000;
/** At most one nudge of a kind per room within this window (ms). */
export const NUDGE_COOLDOWN_MS = 60_000;
/** Bound on the in-memory dedupe sets before they are pruned or cleared. */
export const DEDUPE_MAX = 50_000;
/** Default Redis key prefix of the signal store. */
export const SIGNALS_KEY_PREFIX = "chizzy:signals:";

/** Why a device was given low priority; the label of chizzy_low_priority_total. */
export const LOW_PRIORITY_CAUSE = { risk: "risk", earlySkip: "early-skip" } as const;
export type LowPriorityCause = (typeof LOW_PRIORITY_CAUSE)[keyof typeof LOW_PRIORITY_CAUSE];

/** Who a moderation signal counts against. */
export const SIGNAL_TARGET = { self: "self", partner: "partner" } as const;

/** Risk points per moderation signal kind, and who they count against. */
export const SIGNAL_RISK: Record<ModerationSignalPayload["kind"], { points: number; against: keyof typeof SIGNAL_TARGET }> = {
  // The sender's own camera label looks like OBS, ManyCam or similar.
  "virtual-camera": { points: 3, against: SIGNAL_TARGET.self },
  // The receiver's on-device model blurred the partner's video.
  "nsfw-blur": { points: 2, against: SIGNAL_TARGET.partner },
  "no-face": { points: 0, against: SIGNAL_TARGET.self },
  "model-unavailable": { points: 0, against: SIGNAL_TARGET.self },
};
