import { describe, expect, test } from "bun:test";
import type { ErrorEvent } from "@sentry/node";
import { captureError, initSentry, scrubEvent } from "../../src/observability/sentry";

describe("sentry", () => {
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
});
