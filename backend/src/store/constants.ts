/**
 * Named values for the matchmaking store: the state vocabularies of
 * MatchStore.ts and the sizes, TTLs and lock tuning of MemoryStore.ts and
 * RedisStore.ts. Matchmaking timings (accept window, sweep interval,
 * instance TTL) are env-driven and live in config.ts.
 */

/** Lifecycle of a session: idle -> waiting -> pending (matched, accept window) -> active (in a call). */
export const SESSION_STATES = ["idle", "waiting", "pending", "active"] as const;
/** A room is pending until both accepted, then active until it ends. */
export const ROOM_STATES = ["pending", "active"] as const;

/** Max entries kept in the report log (newest win). */
export const REPORT_LOG_MAX = 10_000;
/** The memory store drops expired pair blocks after this many block writes. */
export const PRUNE_EVERY_WRITES = 1_000;

/** Default Redis key prefix; tests use a unique prefix per store. */
export const MATCH_KEY_PREFIX = "chizzy:";
/** Redis connect timeout (ms) shared with the Socket.IO adapter clients. */
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
/** A hung connection fails the command after this (ms) instead of stalling every queued withLock() caller. */
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
/** Commands are retried this many times during an outage, then fail instead of queueing for minutes. */
export const REDIS_MAX_RETRIES_PER_REQUEST = 2;

/**
 * Default lock lease (ms). The holder extends it while its critical section
 * runs (see LOCK_RENEW_SHARE); a section that still outlives the lease, or
 * whose renewal finds the lease gone, is logged as an error.
 */
export const LOCK_TTL_MS = 3_000;
/** The holder renews its lease every LOCK_TTL_MS x this (ms), so a slow section keeps the lock. */
export const LOCK_RENEW_SHARE = 1 / 3;
/**
 * Renewal stops once a section has run this long (ms): a hung section must
 * lapse like it did before renewal existed, not freeze every replica.
 * Nothing legitimate runs this long (callers give up after LOCK_WAIT_MS).
 */
export const LOCK_HOLD_MAX_MS = 30_000;
/** Default time (ms) a withLock() caller waits for the lock, including time queued locally. */
export const LOCK_WAIT_MS = 10_000;
/** First retry delay (ms) when the lock is taken; doubles up to the cap (equal jitter). */
export const LOCK_BACKOFF_START_MS = 4;
export const LOCK_BACKOFF_MAX_MS = 50;

/**
 * Safety-net TTL (ms) added to a pending room's accept deadline. The sweeper
 * always ends pending rooms; active rooms have no TTL (a call may run for days).
 */
export const PENDING_ROOM_GRACE_MS = 60 * 60_000;
/** How long (ms) the reporters index for a device lives after its last report. */
export const REPORTS_AGAINST_TTL_MS = 30 * 24 * 60 * 60_000;
