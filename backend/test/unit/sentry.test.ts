import { afterEach, describe, expect, test } from "bun:test";
import type { ErrorEvent } from "@sentry/node";
import { SENTRY_BUDGET_WINDOW_MS, SENTRY_MAX_EVENTS_PER_WINDOW } from "../../src/observability/constants";
import { captureError, initSentry, scrubEvent, scrubMessage, setSentryClientForTests } from "../../src/observability/sentry";

describe("sentry", () => {
  afterEach(() => setSentryClientForTests(undefined));

  test("is a no-op without a DSN", async () => {
    expect(await initSentry({ sentryDsn: undefined, nodeEnv: "test" })).toBe(false);
    expect(() => captureError(new Error("x"))).not.toThrow();
  });

  test("scrubEvent strips bodies, headers, query strings, users, extras and breadcrumb payloads", () => {
    const event = {
      type: undefined,
      message: "boom",
      server_name: "ip-10-0-0-1",
      request: {
        method: "POST",
        url: "https://api.example.com/api/restrictions/abc?deviceId=123",
        data: { dob: "2010-01-01", name: "Asha" },
        headers: { cookie: "x", "x-real-ip": "1.2.3.4" },
        cookies: { a: "b" },
        query_string: "deviceId=123",
      },
      user: { ip_address: "1.2.3.4", id: "device" },
      extra: { chat: ["hi"] },
      contexts: { runtime: { name: "node" }, os: { name: "Linux" }, report: { evidence: "data:image/jpeg;base64,AAAA" } },
      breadcrumbs: [{ category: "http", type: "http", message: "POST /api/session", data: { body: "dob" }, timestamp: 1 }],
      exception: {
        values: [{ type: "Error", value: "boom", stacktrace: { frames: [{ function: "f", vars: { name: "Asha" } }] } }],
      },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);
    expect(out.request).toEqual({ method: "POST", url: "https://api.example.com/api/restrictions/abc" });
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(Object.keys(out.contexts ?? {}).sort()).toEqual(["os", "runtime"]);
    expect(out.breadcrumbs).toEqual([{ category: "http", type: "http", level: undefined, timestamp: 1 }]);
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/Asha|2010-01-01|1\.2\.3\.4|deviceId|evidence|chat/);
  });

  test("error messages lose ids, addresses, emails and data URLs, keep the rest", () => {
    expect(
      scrubMessage(
        'session 0b6f3c1e-9a4d-4c55-8f0e-2d7c9a1b3e4f from 203.0.113.9 and 2001:db8::1 (a@b.example) sent "data:image/jpeg;base64,/9j/4AAQ" at 10:20:30',
      ),
    ).toBe('session [id] from [ip] and [ip] ([email]) sent "[data-url]" at 10:20:30');
    const out = scrubEvent({
      type: undefined,
      message: "user 0b6f3c1e-9a4d-4c55-8f0e-2d7c9a1b3e4f",
      exception: { values: [{ type: "SyntaxError", value: 'Unexpected token, "1.2.3.4" is not valid JSON' }] },
    } as ErrorEvent);
    expect(out.message).toBe("user [id]");
    expect(out.exception?.values?.[0]?.value).toBe('Unexpected token, "[ip]" is not valid JSON');
  });

  test("a flood of failures sends a bounded number of events per window, then says how many were dropped", () => {
    const exceptions: unknown[] = [];
    const messages: string[] = [];
    let now = 1_000;
    setSentryClientForTests(
      {
        captureException: (err: unknown) => {
          exceptions.push(err);
          return "id";
        },
        captureMessage: (msg: string) => {
          messages.push(msg);
          return "id";
        },
        close: async () => true,
      },
      () => now,
    );
    // One client action that fails every time, repeated far past the budget.
    for (let i = 0; i < 10 * SENTRY_MAX_EVENTS_PER_WINDOW; i++) captureError(new Error("redis down"), { event: "spark:request" });
    expect(exceptions).toHaveLength(SENTRY_MAX_EVENTS_PER_WINDOW);
    expect(messages).toEqual([]);

    now += SENTRY_BUDGET_WINDOW_MS;
    captureError(new Error("still down"));
    expect(messages).toEqual([`${9 * SENTRY_MAX_EVENTS_PER_WINDOW} errors over the Sentry budget were not sent (see the logs)`]);
    expect(exceptions).toHaveLength(SENTRY_MAX_EVENTS_PER_WINDOW + 1);
  });
});
