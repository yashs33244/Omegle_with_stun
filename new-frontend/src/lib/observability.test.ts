import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SENTRY_EVENTS_PER_PAGE,
  initObservability,
  resetObservabilityForTests,
  scrubEvent,
  setCaptureForTests,
  track,
  trackOnce,
} from "./observability";

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/react", () => sentry);
vi.mock("@/lib/idle", () => ({ pageIdle: () => Promise.resolve() }));

beforeEach(() => {
  resetObservabilityForTests();
  sentry.init.mockReset();
});

describe("Sentry event budget", () => {
  it("sends at most SENTRY_EVENTS_PER_PAGE events per page load, scrubbed, then drops the rest", async () => {
    await initObservability({ sentryDsn: "https://key@sentry.example/1", posthogKey: null, posthogHost: null });
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const { beforeSend } = sentry.init.mock.calls[0]![0] as { beforeSend: (e: object) => object | null };
    const event = () => ({ user: { id: "device" }, message: "boom" });
    const sent = Array.from({ length: SENTRY_EVENTS_PER_PAGE + 5 }, () => beforeSend(event()));
    expect(SENTRY_EVENTS_PER_PAGE).toBe(20);
    expect(sent.slice(0, SENTRY_EVENTS_PER_PAGE)).toEqual(Array(SENTRY_EVENTS_PER_PAGE).fill({ message: "boom" }));
    expect(sent.slice(SENTRY_EVENTS_PER_PAGE)).toEqual(Array(5).fill(null));

    // A new page load (module state reset) gets a fresh budget.
    resetObservabilityForTests();
    await initObservability({ sentryDsn: "https://key@sentry.example/1", posthogKey: null, posthogHost: null });
    const next = sentry.init.mock.calls[1]![0] as { beforeSend: (e: object) => object | null };
    expect(next.beforeSend(event())).toEqual({ message: "boom" });
  });
});

describe("scrubEvent", () => {
  it("removes the user, request details, personal fields, data URLs and input breadcrumbs", () => {
    const photo = "data:image/jpeg;base64,AAAABBBB";
    const event = scrubEvent({
      user: { id: "device", ip_address: "1.2.3.4" },
      request: { url: "https://chizzy.example/?ref=abc", headers: { cookie: "x" }, data: "body" },
      extra: { name: "Asha", chatText: "hi there", nested: { photo, roomId: "r1" }, count: 3 },
      contexts: { profile: { name: "Asha" }, app: { version: "1" } },
      breadcrumbs: [
        { category: "ui.input", message: "typed" },
        { category: "console", message: "Asha said hi" },
        { category: "navigation", data: { to: "/" } },
      ],
      exception: { values: [{ value: `bad frame ${photo}` }] },
      message: `photo ${photo}`,
    });
    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({ url: "https://chizzy.example/" });
    expect(event.extra).toEqual({ name: "[redacted]", chatText: "[redacted]", nested: { photo: "[redacted]", roomId: "r1" }, count: 3 });
    expect(event.contexts).toEqual({ profile: "[redacted]", app: { version: "1" } });
    expect(event.breadcrumbs?.map((b) => b.category)).toEqual(["navigation"]);
    expect(event.exception?.values?.[0]?.value).toBe("bad frame [redacted]");
    expect(event.message).toBe("photo [redacted]");
    expect(JSON.stringify(event)).not.toContain("base64");
  });
});

describe("track", () => {
  it("sends once-only events a single time", () => {
    const spy = vi.fn();
    setCaptureForTests(spy);
    trackOnce("first_match");
    trackOnce("first_match");
    track("call_connected", { relayed: false });
    expect(spy.mock.calls).toEqual([["first_match", undefined], ["call_connected", { relayed: false }]]);
  });
});
