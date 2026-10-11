/**
 * Backend error tracking (Sentry). A no-op unless SENTRY_DSN is set.
 *
 * Privacy: events never carry request bodies (dates of birth, chat, report
 * evidence, photos), headers, cookies, query strings (device ids), users,
 * extras or breadcrumb payloads. scrubEvent() enforces that on every event.
 *
 * The SDK is loaded only when a DSN is set: importing it costs real startup time.
 */
import type * as SentryNode from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import type { Config } from "../config";

/** Standard runtime contexts; anything else could hold user data. */
const SAFE_CONTEXTS = new Set(["runtime", "os", "app", "device", "culture", "cloud_resource", "trace"]);

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
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
  }
  return event;
}

/** Keeps only what happened and when, never the payload. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  return { type: crumb.type, category: crumb.category, level: crumb.level, timestamp: crumb.timestamp };
}

let sentry: typeof SentryNode | undefined;

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
  sentry?.captureException(err, tags ? { tags } : undefined);
}

/** Flushes queued events on shutdown. */
export async function closeSentry(timeoutMs = 2_000): Promise<void> {
  await sentry?.close(timeoutMs);
}
