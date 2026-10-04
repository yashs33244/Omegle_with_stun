import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetObservabilityForTests,
  scrubEvent,
  setCaptureForTests,
  track,
  trackOnce,
} from "./observability";

beforeEach(() => resetObservabilityForTests());

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
