/**
 * Named values for the TURN module: credential issuance (TurnService.ts),
 * the Cloudflare APIs (cloudflare.ts, spendPoller.ts) and storage
 * (store.ts). Env-driven values stay in config.ts (turnProvider, turnUrls,
 * turnSecret, turnTtlSeconds, turnCacheSeconds, turnMaxPerDeviceHour,
 * turnMaxPerIpHour, cfTurn*, turnSpend*).
 */

/* ------------------------------------------------------------------ */
/* Time units (ms)                                                     */
/* ------------------------------------------------------------------ */

export const SECOND_MS = 1_000;
export const HOUR_MS = 60 * 60 * SECOND_MS;
export const DAY_MS = 24 * HOUR_MS;

/* ------------------------------------------------------------------ */
/* Credential issuance (TurnService.ts)                                */
/* ------------------------------------------------------------------ */

/** The device -> IP-hash binding recorded at hello lives this long (ms). */
export const DEVICE_IP_TTL_MS = DAY_MS;
/** Per-device and per-IP credential caps use fixed windows of this length (ms). */
export const CAP_WINDOW_MS = HOUR_MS;
/** Random bytes of the per-process IP-hash secret used when no shared secret is configured. */
export const IP_SECRET_BYTES = 32;
/** Hex characters kept of the IP hash (128 bits). */
export const IP_KEY_HEX_CHARS = 32;
/** Domain separator so the IP hash can never collide with other HMACs of the same secret. */
export const IP_KEY_DOMAIN = "chizzy-turn-ip:";

/** Outcomes of a credential request; the label of chizzy_turn_credentials_total. */
export const CREDENTIAL_RESULT = {
  /** flags.turn_enabled is off. */
  disabled: "disabled",
  /** A cached set from an earlier call of the same device. */
  cached: "cached",
  /** Over the per-device or per-IP hourly cap. */
  capped: "capped",
  /** No address to count the set against (no hello binding, no socket address): refused. */
  noIp: "no_ip",
  issued: "issued",
  error: "error",
} as const;
export type CredentialResult = (typeof CREDENTIAL_RESULT)[keyof typeof CREDENTIAL_RESULT];

/* ------------------------------------------------------------------ */
/* Cloudflare Realtime TURN API (cloudflare.ts)                        */
/* ------------------------------------------------------------------ */

export const CLOUDFLARE_TURN_API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys/";
/** Timeout (ms) for the generate-ice-servers call; a slow answer delays call:start. */
export const CLOUDFLARE_TURN_TIMEOUT_MS = 3 * SECOND_MS;
/** Browsers block this port and it only slows ICE down, so such URLs are dropped. */
export const BLOCKED_ICE_PORT = 53;

/* ------------------------------------------------------------------ */
/* Spend cap (spendPoller.ts)                                          */
/* ------------------------------------------------------------------ */

export const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** Timeout (ms) for the analytics query. */
export const CLOUDFLARE_GRAPHQL_TIMEOUT_MS = 10 * SECOND_MS;
/** Most adaptive groups requested per analytics query (one per minute of the day). */
export const CLOUDFLARE_GRAPHQL_GROUP_LIMIT = 10_000;
/** Bytes per gigabyte, as Cloudflare bills (decimal). */
export const BYTES_PER_GB = 1e9;
/** First step-down: relay video bitrate cap (kbps). */
export const RELAY_STEP_DOWN_KBPS = 300;
/** Redis key of the lease that picks the polling instance. */
export const SPEND_LOCK_KEY = "chizzy:lock:turn-spend";
/** The lease lasts this share of the poll interval, so it expires before the next poll. */
export const SPEND_LOCK_LEASE_SHARE = 0.9;
/** Shortest lease (ms), for very short intervals in tests. */
export const SPEND_LOCK_MIN_TTL_MS = SECOND_MS;
/**
 * Consecutive failed polls (4 x 15 min = 1 h) after which the poller stops
 * trusting that spend is under the cap and applies the failsafe steps.
 */
export const SPEND_FAILSAFE_AFTER_FAILURES = 4;
/** Redis key of the failure streak shared by the instances (expires after a few missed polls). */
export const SPEND_FAILURES_KEY = "chizzy:turn-spend:failures";

/** Step names, in order; the label of chizzy_turn_spend_steps_total. */
export const SPEND_STEP = {
  relayBitrate: "relay-bitrate",
  privateModeOff: "private-mode-off",
  turnOff: "turn-off",
} as const;
export type SpendStep = (typeof SPEND_STEP)[keyof typeof SPEND_STEP];

/* ------------------------------------------------------------------ */
/* Storage (store.ts)                                                  */
/* ------------------------------------------------------------------ */

/** Default Redis key prefix of the TURN store. */
export const TURN_KEY_PREFIX = "chizzy:turn:";
/** The memory store drops expired entries after this many writes. */
export const PRUNE_EVERY_WRITES = 1_000;
