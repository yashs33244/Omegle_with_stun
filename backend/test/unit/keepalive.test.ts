import { afterEach, describe, expect, test, vi } from "bun:test";
import { startKeepalive } from "../../src/keepalive";
import { createLogger } from "../../src/logger";

const logger = createLogger("silent");

/** Lets the awaited fetch inside a tick settle before asserting. */
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("keep-alive", () => {
  afterEach(() => vi.useRealTimers());

  test("GETs the URL on every tick, survives failures, and stops cleanly", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let fail = true;
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (fail) throw new Error("ECONNRESET");
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const stop = startKeepalive({ url: "https://api.example/healthz", logger, intervalMs: 1000, fetch });
    expect(calls).toEqual([]); // nothing before the first interval

    vi.advanceTimersByTime(2000);
    await flush();
    expect(calls).toEqual(["https://api.example/healthz", "https://api.example/healthz"]); // failures keep the timer

    fail = false;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(3);

    stop();
    vi.advanceTimersByTime(5000);
    await flush();
    expect(calls).toHaveLength(3);
  });
});
