/**
 * Backend error tracking (Sentry). A no-op unless SENTRY_DSN is set.
 *
 * Privacy: events never carry request bodies (dates of birth, chat, report
 * evidence, photos), headers, cookies, query strings (device ids), users,
 * extras or breadcrumb payloads; ids, addresses, emails and data URLs inside
 * error messages are masked. scrubEvent() enforces that on every event.
 *
 * Volume: captureError() sends at most SENTRY_MAX_EVENTS_PER_WINDOW events
 * per SENTRY_BUDGET_WINDOW_MS and process, whatever the clients do; the rest
 * are only logged by the caller. Sending never blocks: the SDK queues and
 * ships events in the background.
 *
 * The SDK is loaded only when a DSN is set: importing it costs real startup time.
 */
import type * as SentryNode from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import type { Config } from "../config";
import { SENTRY_BUDGET_WINDOW_MS, SENTRY_MAX_EVENTS_PER_WINDOW } from "./constants";

/** Standard runtime contexts; anything else could hold user data. */
const SAFE_CONTEXTS = new Set(["runtime", "os", "app", "device", "culture", "cloud_resource", "trace"]);

/**
 * Personal values an error message can quote (a library echoing its input):
 * data URLs (frames, photos), UUIDs (device, session and room ids), emails,
 * IPv4 and IPv6 addresses.
 */
const MESSAGE_PII: [RegExp, string][] = [
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi, "[data-url]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  // Full (eight groups) or compressed (with "::") IPv6; times like 10:20:30 do not match.
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi, "[ip]"],
];

export function scrubMessage(text: string): string {
  return MESSAGE_PII.reduce((out, [pattern, mask]) => out.replace(pattern, mask), text);
}

export function scrubEvent<E extends ErrorEvent>(event: E): E {
  if (event.request) {
    const url = event.request.url?.split("?")[0];
    event.request = { method: event.request.method, ...(url ? { url } : {}) };
  }
  delete event.user;
  delete event.extra;
  delete event.server_name;
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) if (!SAFE_CONTEXTS.has(key)) delete event.contexts[key];
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (typeof event.message === "string") event.message = scrubMessage(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubMessage(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
  }
  return event;
}

/** Keeps only what happened and when, never the payload. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  return { type: crumb.type, category: crumb.category, level: crumb.level, timestamp: crumb.timestamp };
}

type SentryClient = Pick<typeof SentryNode, "captureException" | "captureMessage" | "close">;

let sentry: SentryClient | undefined;
let clock: () => number = Date.now;
/** Fixed-window event budget of captureError. */
const budget = { windowStart: Number.NEGATIVE_INFINITY, sent: 0, dropped: 0 };

/** Call once at startup, before the server is created. Resolves with whether Sentry is on. */
export async function initSentry(config: Pick<Config, "sentryDsn" | "nodeEnv">): Promise<boolean> {
  if (!config.sentryDsn) return false;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    // Collect nothing about users or requests; scrubEvent is the second line of defence.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    // Errors only: no tracing, no profiling.
    defaultIntegrations: Sentry.getDefaultIntegrationsWithoutPerformance(),
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    maxBreadcrumbs: 30,
  });
  sentry = Sentry;
  return true;
}

export function captureError(err: unknown, tags?: Record<string, string>): void {
  if (!sentry) return;
  const now = clock();
  if (now - budget.windowStart >= SENTRY_BUDGET_WINDOW_MS) {
    const dropped = budget.dropped;
    Object.assign(budget, { windowStart: now, sent: 0, dropped: 0 });
    if (dropped > 0) {
      budget.sent++;
      sentry.captureMessage(`${dropped} errors over the Sentry budget were not sent (see the logs)`, "warning");
    }
  }
  if (budget.sent >= SENTRY_MAX_EVENTS_PER_WINDOW) {
    budget.dropped++;
    return;
  }
  budget.sent++;
  sentry.captureException(err, tags ? { tags } : undefined);
}

/** Flushes queued events on shutdown. */
export async function closeSentry(timeoutMs = 2_000): Promise<void> {
  await sentry?.close(timeoutMs);
}

/** Test seam: a fake client and clock instead of the SDK; resets the budget. `undefined` turns Sentry off again. */
export function setSentryClientForTests(client: SentryClient | undefined, now: () => number = Date.now): void {
  sentry = client;
  clock = now;
  Object.assign(budget, { windowStart: Number.NEGATIVE_INFINITY, sent: 0, dropped: 0 });
}
