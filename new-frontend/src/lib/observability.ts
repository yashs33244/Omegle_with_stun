/**
 * Error tracking (Sentry) and product analytics (PostHog), both optional.
 *
 * Nothing loads unless /api/config returns a key: the SDKs are separate chunks
 * fetched on demand, and only once the page is idle so they never compete with
 * the first paint; events and errors raised before then are queued. PostHog
 * runs cookieless (memory persistence), without autocapture or session
 * recording, and IP properties are dropped before sending. Sentry events are
 * scrubbed of names, chat text, photos and evidence.
 */
import { pageIdle } from "@/lib/idle";
import type { PublicConfig } from "@/lib/protocol";

export type FunnelEvent =
  | "landing_view"
  | "camera_granted"
  | "gate_passed"
  | "first_match"
  | "match_accepted"
  | "call_connected"
  | "third_call";

/** Only coarse, non-identifying values. */
export type EventProps = Record<string, string | number | boolean | null>;

type Capture = (event: FunnelEvent, props?: EventProps) => void;
type CaptureError = (error: unknown) => void;

let capture: Capture | null = null;
let captureErrorImpl: CaptureError | null = null;
let started = false;
/** Events fired before PostHog finished loading. Dropped if it never loads. */
let queue: Array<[FunnelEvent, EventProps | undefined]> = [];
/** Errors raised before Sentry finished loading. Dropped if it never loads. */
let errorQueue: unknown[] = [];
const QUEUE_MAX = 50;
const onceFired = new Set<string>();
/** Upper bound on how long the SDK loads wait for an idle moment after the page has loaded. */
const IDLE_TIMEOUT_MS = 3000;

/** Records a funnel event. Safe to call from anywhere; a no-op without a PostHog key. */
export function track(event: FunnelEvent, props?: EventProps): void {
  if (capture) {
    capture(event, props);
    return;
  }
  if (queue.length < QUEUE_MAX) queue.push([event, props]);
}

/** Records the event at most once per page load. */
export function trackOnce(event: FunnelEvent, props?: EventProps): void {
  if (onceFired.has(event)) return;
  onceFired.add(event);
  track(event, props);
}

/** Reports an unexpected error to Sentry when it is configured. */
export function captureError(error: unknown): void {
  if (captureErrorImpl) {
    captureErrorImpl(error);
    return;
  }
  if (errorQueue.length < QUEUE_MAX) errorQueue.push(error);
}

/* ------------------------------------------------------------------ */
/* Scrubbing                                                           */
/* ------------------------------------------------------------------ */

const SENSITIVE_KEY = /name|chat|text|message|photo|frame|evidence|dob|birth|profile|token|email|^ip$|ip_?address/i;
const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const REDACTED = "[redacted]";

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(DATA_URL, REDACTED);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(v, depth + 1);
  }
  return out;
}

interface ScrubbableEvent {
  user?: unknown;
  request?: { cookies?: unknown; data?: unknown; headers?: unknown; query_string?: unknown; url?: string };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
  exception?: { values?: Array<{ value?: string }> };
  message?: string;
}

/** Breadcrumb categories that can carry what people typed or clicked on. */
const DROPPED_BREADCRUMBS = new Set(["ui.input", "ui.click", "console"]);

/**
 * Sentry beforeSend: removes the user, request bodies and query strings, any
 * field whose key suggests personal content, data URLs (photos, frames), and
 * breadcrumbs that could quote chat or names.
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  const out: E = { ...event };
  delete out.user;
  if (out.request) {
    const { url } = out.request;
    out.request = url ? { url: url.split("?")[0] } : {};
  }
  if (out.extra) out.extra = scrubValue(out.extra) as Record<string, unknown>;
  if (out.contexts) out.contexts = scrubValue(out.contexts) as Record<string, unknown>;
  if (out.tags) out.tags = scrubValue(out.tags) as Record<string, unknown>;
  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .filter((b) => !DROPPED_BREADCRUMBS.has(b.category ?? ""))
      .map((b) => ({ ...b, data: b.data ? (scrubValue(b.data) as Record<string, unknown>) : undefined }));
  }
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((v) => (v.value ? { ...v, value: scrubValue(v.value) as string } : v)),
    };
  }
  if (typeof out.message === "string") out.message = scrubValue(out.message) as string;
  return out;
}

/**
 * Sentry events one page load may send; later ones are dropped, so an error
 * loop in one tab cannot use up the project's quota (the backend has its own
 * per-process budget, backend/src/observability/constants.ts).
 */
export const SENTRY_EVENTS_PER_PAGE = 20;
let sentryEventsSent = 0;

/** Sentry beforeSend: drops events past SENTRY_EVENTS_PER_PAGE, scrubs the rest. */
export function beforeSendEvent<E extends ScrubbableEvent>(event: E): E | null {
  if (sentryEventsSent >= SENTRY_EVENTS_PER_PAGE) return null;
  sentryEventsSent++;
  return scrubEvent(event);
}

/** PostHog properties that identify a person or a network location. */
export const POSTHOG_DENYLIST = ["$ip", "$current_url", "$referrer", "$referring_domain", "$initial_referrer", "$initial_referring_domain"];

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

async function initSentry(dsn: string): Promise<void> {
  const Sentry = await import("@sentry/react");
  Sentry.init({
    dsn,
    // No user info, cookies, headers, query strings or bodies.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    // Default integrations include breadcrumbs; scrubEvent filters what they carry.
    beforeSend: (event) => beforeSendEvent(event),
    beforeBreadcrumb: (crumb) => (DROPPED_BREADCRUMBS.has(crumb.category ?? "") ? null : crumb),
  });
  captureErrorImpl = (error) => Sentry.captureException(error);
  const pending = errorQueue;
  errorQueue = [];
  pending.forEach((error) => captureErrorImpl?.(error));
}

async function initPosthog(key: string, host: string | null): Promise<void> {
  const { default: posthog } = await import("posthog-js");
  posthog.init(key, {
    api_host: host ?? "https://us.i.posthog.com",
    persistence: "memory",
    disable_persistence: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    save_referrer: false,
    mask_personal_data_properties: true,
    person_profiles: "never",
    property_denylist: POSTHOG_DENYLIST,
    before_send: (event) => {
      if (!event) return event;
      for (const key of POSTHOG_DENYLIST) delete event.properties?.[key];
      return event;
    },
  });
  capture = (event, props) => {
    posthog.capture(event, props ?? {});
  };
  const pending = queue;
  queue = [];
  pending.forEach(([event, props]) => capture?.(event, props));
}

/** Starts whatever the runtime config enables. Called once with /api/config. */
export async function initObservability(config: Pick<PublicConfig, "sentryDsn" | "posthogKey" | "posthogHost">): Promise<void> {
  if (started) return;
  started = true;
  if (!config.posthogKey) {
    queue = [];
    capture = () => {};
  }
  if (!config.sentryDsn) errorQueue = [];
  if (!config.sentryDsn && !config.posthogKey) return;
  await pageIdle(IDLE_TIMEOUT_MS);
  const jobs: Promise<void>[] = [];
  if (config.sentryDsn) jobs.push(initSentry(config.sentryDsn));
  if (config.posthogKey) jobs.push(initPosthog(config.posthogKey, config.posthogHost));
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") console.warn("Observability failed to start", r.reason);
  }
}

/** Test helper. */
export function resetObservabilityForTests(): void {
  capture = null;
  captureErrorImpl = null;
  started = false;
  queue = [];
  errorQueue = [];
  sentryEventsSent = 0;
  onceFired.clear();
}

/** Test helper: route events to a spy instead of PostHog. */
export function setCaptureForTests(fn: Capture | null): void {
  capture = fn;
}
