/**
 * Named values for the operator flags module (flags.ts). The flag values
 * themselves and their defaults live in protocol.ts (FLAG_DEFAULTS).
 */

/** Redis hash that holds the stored flag overrides. */
export const FLAGS_KEY = "chizzy:flags";
/** FlagsReader refreshes its cache this often (ms); current() is never older than this. */
export const FLAGS_CACHE_TTL_MS = 2_000;

export const MINUTE_MS = 60_000;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const NOON_MINUTES = 12 * MINUTES_PER_HOUR;
/** Locale used to read local hours and minutes in a time zone (h23 clock). */
export const CLOCK_LOCALE = "en-GB";
/** Cached Intl.DateTimeFormat instances (one per staffed-hours time zone); the cache is cleared past this. */
export const FORMATTER_CACHE_MAX = 8;

/** Shown when the kill switch is off and no banner message is set. */
export const PAUSED_MESSAGE = "Matching is paused right now.";
