/**
 * Limits of the backend Sentry client (sentry.ts). Not env-driven: the DSN
 * (SENTRY_DSN) is the only Sentry setting in config.ts.
 */

/** Length (ms) of the fixed window the event budget counts in. */
export const SENTRY_BUDGET_WINDOW_MS = 60_000;
/**
 * Errors sent to Sentry per window and process. Past it they are dropped
 * (they are still logged), so a request or socket event that fails on every
 * call cannot turn client traffic into an unbounded stream of events, burn
 * the plan's quota or fill the SDK's send queue.
 */
export const SENTRY_MAX_EVENTS_PER_WINDOW = 30;
