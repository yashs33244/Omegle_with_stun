/**
 * Named values for the session gate: ages, tokens, lockouts, rate-limit
 * windows, Turnstile, geo parsing and the queue gate copy. Env-driven values
 * stay in config.ts (sessionSecret*, sessionRatePer*, matchCapPer*,
 * turnstileSecret, trustCloudflare, proxyIpHeader, matchingStatusIntervalMs).
 */
import type { ErrorCode, SessionError } from "../protocol";

/* ------------------------------------------------------------------ */
/* Time units (ms)                                                     */
/* ------------------------------------------------------------------ */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/* ------------------------------------------------------------------ */
/* Age (age.ts)                                                        */
/* ------------------------------------------------------------------ */

/** Minimum age (years) to use the service. */
export const ADULT_AGE = 18;
/** Dates of birth before this year are treated as typos and rejected. */
export const MIN_BIRTH_YEAR = 1900;

/* ------------------------------------------------------------------ */
/* Tokens (tokens.ts)                                                  */
/* ------------------------------------------------------------------ */

/** Token format version; the first segment of every token. */
export const TOKEN_PREFIX = "c1";
/** Longer strings are rejected before any parsing (a real token is a few hundred chars). */
export const MAX_TOKEN_CHARS = 4096;
/** Domain separator for the signing key derived from SESSION_SECRET. */
export const TOKEN_KEY_DOMAIN = "chizzy:token:v1";
/** A session token (socket handshake) lives this long (ms). */
export const SESSION_TOKEN_TTL_MS = DAY_MS;
/** An age token (18+ and Terms accepted) lives this long (ms); the expiry never slides. */
export const AGE_TOKEN_TTL_MS = 180 * DAY_MS;

/* ------------------------------------------------------------------ */
/* Limits (limits.ts, kv.ts)                                           */
/* ------------------------------------------------------------------ */

/** A device that proved it is under 18 stays locked out this long (ms). */
export const DEVICE_LOCKOUT_MS = 365 * DAY_MS;
/**
 * The fingerprint is coarse (many phones of one model share it), so it is only
 * used together with the network block, and for a shorter time (ms), to keep
 * strangers on the same carrier from being locked out with the child.
 */
export const FINGERPRINT_LOCKOUT_MS = 30 * DAY_MS;
/** Session rate limits use fixed windows of this length (ms). */
export const SESSION_RATE_WINDOW_MS = MINUTE_MS;
/** Match caps use fixed windows of this length (ms). */
export const MATCH_CAP_WINDOW_MS = HOUR_MS;
/** The device -> IP-hash binding made at the handshake lives this long (ms). */
export const MATCH_CAP_IP_BINDING_TTL_MS = DAY_MS;
/** Domain separator for salts derived from SESSION_SECRET. */
export const SALT_DOMAIN = "chizzy:salt:";
/** Salt purposes: one salt per use so hashes of one table never match another. */
export const SALT_PURPOSE = { limits: "limits", lockout: "lockout" } as const;
/** Default Redis key prefix of the session KV. */
export const SESSION_KEY_PREFIX = "chizzy:session:";
/** The memory KV drops expired entries after this many operations. */
export const PRUNE_EVERY_OPS = 1_000;

/** Key builders for the session KV (values are salted hashes, never raw IPs or fingerprints). */
export const KEY = {
  deviceLockout: (deviceHash: string) => `lock:d:${deviceHash}`,
  fingerprintLockout: (fingerprintHash: string) => `lock:f:${fingerprintHash}`,
  ipRate: (ipHash: string, window: number) => `rl:ip:${ipHash}:${window}`,
  networkRate: (networkHash: string, window: number) => `rl:net:${networkHash}:${window}`,
  capIpOf: (deviceId: string) => `cap:ipof:${deviceId}`,
  capDevice: (deviceId: string, hour: number) => `cap:d:${deviceId}:${hour}`,
  capIp: (ipHash: string, hour: number) => `cap:i:${ipHash}:${hour}`,
} as const;

/* ------------------------------------------------------------------ */
/* Turnstile (turnstile.ts)                                            */
/* ------------------------------------------------------------------ */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Timeout (ms) for Siteverify; a slow answer counts as a failure (fail closed). */
export const TURNSTILE_TIMEOUT_MS = 5 * SECOND_MS;
/** Local error codes, alongside the ones Cloudflare returns. */
export const TURNSTILE_LOCAL_ERROR = {
  missingToken: "missing-input-response",
  badResponse: "bad-response",
  networkError: "network-error",
} as const;

/* ------------------------------------------------------------------ */
/* Geo (geo.ts)                                                        */
/* ------------------------------------------------------------------ */

/** Cloudflare's country header, trusted only with TRUST_CLOUDFLARE. */
export const COUNTRY_HEADER = "cf-ipcountry";
/** Cloudflare sends this when the country is unknown. */
export const UNKNOWN_COUNTRY = "XX";
/** Client IP when neither the proxy header nor the TCP peer is known. */
export const UNKNOWN_IP = "unknown";
/** IPv4 addresses arrive as "::ffff:a.b.c.d" on dual-stack sockets. */
export const IPV4_MAPPED_PREFIX = "::ffff:";
/** An IPv4 /24 keeps the first three octets. */
export const IPV4_NETWORK_OCTETS = 3;
/** An expanded IPv6 address has eight 16-bit groups. */
export const IPV6_GROUPS = 8;
/** An IPv6 /64 (one subscriber) keeps four groups; a /48 (the surrounding block) keeps three. */
export const IPV6_SUBSCRIBER_GROUPS = 4;
export const IPV6_NETWORK_GROUPS = 3;

/* ------------------------------------------------------------------ */
/* HTTP and socket responses (SessionService.ts, handshake.ts)         */
/* ------------------------------------------------------------------ */

/** HTTP status per POST /api/session error. */
export const SESSION_ERROR_STATUS: Record<SessionError, number> = {
  invalid: 400,
  tos_outdated: 400,
  age_token_invalid: 401,
  underage: 403,
  locked: 403,
  region_blocked: 403,
  turnstile_failed: 403,
  banned: 403,
  rate_limited: 429,
  closed: 503,
};

/** connect_error codes the handshake gate can answer with (a subset of ErrorCode). */
export const HANDSHAKE_REJECT_CODES = ["session_required", "region_blocked"] as const satisfies readonly ErrorCode[];

/* ------------------------------------------------------------------ */
/* Queue gate copy (queueGate.ts)                                      */
/* ------------------------------------------------------------------ */

export const CAP_MESSAGE = "You have had a lot of matches this hour. Take a break and try again later.";
export const FULL_MESSAGE = "A lot of people are waiting right now. Try again in a few minutes.";
export const CLOSED_MESSAGE = "Matching is closed right now.";
