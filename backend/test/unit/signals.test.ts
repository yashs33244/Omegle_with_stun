import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { Registry } from "prom-client";
import { createLogger } from "../../src/logger";
import { createMatchMetrics } from "../../src/match/matchMetrics";
import { MemorySignalStore, RedisSignalStore, SafetySignals, type SignalStore } from "../../src/safety/signals";
import { MemoryTurnStore, RedisTurnStore, type TurnStore } from "../../src/turn/store";
import { delay, testConfig } from "../helpers";

const url = process.env.REDIS_URL;
const redis = url ? new Redis(url) : undefined;
afterAll(async () => {
  await redis?.quit();
});

const signalStores: [string, () => SignalStore][] = [["memory", () => new MemorySignalStore()]];
const turnStores: [string, () => TurnStore][] = [["memory", () => new MemoryTurnStore()]];
if (redis) {
  signalStores.push(["redis", () => new RedisSignalStore(redis, `test:${randomUUID()}:signals:`)]);
  turnStores.push(["redis", () => new RedisTurnStore(redis, `test:${randomUUID()}:turn:`)]);
}

describe.each(signalStores)("%s signal store", (_name, make) => {
  test("risk points add up inside the window and reset after it", async () => {
    const s = make();
    expect(await s.addRisk("d1", 2, 200)).toBe(2);
    expect(await s.addRisk("d1", 3, 200)).toBe(5);
    expect(await s.addRisk("d2", 1, 200)).toBe(1);
    await delay(260);
    expect(await s.addRisk("d1", 1, 200)).toBe(1);
  });

  test("calls and early skips", async () => {
    const s = make();
    await s.recordCall("d1");
    await s.recordCall("d1");
    expect(await s.recordEarlySkip("d1")).toEqual({ calls: 2, early: 1 });
  });

  test("low priority lists live entries and never shortens", async () => {
    const s = make();
    const now = Date.now();
    await s.setLowPriority("d1", now + 60_000);
    await s.setLowPriority("d1", now + 10);
    await s.setLowPriority("d2", now - 1);
    expect(await s.lowPriority(now + 1_000)).toEqual(["d1"]);
  });
});

describe.each(turnStores)("%s turn store", (_name, make) => {
  test("cache, fixed-window counters and the device ip binding", async () => {
    const s = make();
    expect(await s.getCached("d1")).toBeNull();
    await s.setCached("d1", [{ urls: ["turn:x"], username: "u", credential: "c" }], 200);
    expect(await s.getCached("d1")).toEqual([{ urls: ["turn:x"], username: "u", credential: "c" }]);
    expect(await s.hit("dev:d1", 60_000)).toBe(1);
    expect(await s.hit("dev:d1", 60_000)).toBe(2);
    expect(await s.hit("dev:d2", 60_000)).toBe(1);
    await s.setDeviceIp("d1", "hash1", 200);
    expect(await s.getDeviceIp("d1")).toBe("hash1");
    await delay(260);
    expect(await s.getCached("d1")).toBeNull();
    expect(await s.getDeviceIp("d1")).toBeNull();
  });
});

function signals(overrides: Parameters<typeof testConfig>[0] = {}) {
  const metrics = createMatchMetrics(new Registry());
  const store = new MemorySignalStore();
  const config = testConfig({ earlySkipMinCalls: 3, earlySkipShare: 0.6, riskThreshold: 4, ...overrides });
  return { s: new SafetySignals({ store, config, logger: createLogger("silent"), metrics }), metrics, store };
}

const value = async (c: { get(): Promise<{ values: { value: number; labels: Record<string, unknown> }[] }> }, labels = {}) =>
  (await c.get()).values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;

describe("SafetySignals", () => {
  test("early skips above the share give low priority once there are enough calls", async () => {
    const { s, metrics } = signals();
    s.callStarted(["victim", "other"]);
    s.skipped("victim", 1_000);
    await delay(10);
    expect((await s.lowPriority()).has("victim")).toBe(false); // 1 call: not enough data
    s.callStarted(["victim", "x"]);
    s.callStarted(["victim", "y"]);
    s.skipped("victim", 10_000); // late skip: not early
    s.skipped("victim", 500);
    await delay(10);
    expect(await value(metrics.earlySkipsTotal)).toBe(2);
    expect((await s.lowPriority()).has("victim")).toBe(true); // 2 of 3 calls
    expect(await value(metrics.lowPriorityTotal, { cause: "early-skip" })).toBe(1);
  });

  test("moderation signals count once per socket, room and kind; risk goes to the right device", async () => {
    const { s, metrics } = signals();
    s.moderationSignal("sock-a", "room-1", "virtual-camera", "dev-a", "dev-b");
    s.moderationSignal("sock-a", "room-1", "virtual-camera", "dev-a", "dev-b");
    s.moderationSignal("sock-b", "room-1", "nsfw-blur", "dev-b", "dev-a");
    s.moderationSignal("sock-a", "room-1", "model-unavailable", "dev-a", "dev-b");
    await delay(10);
    expect(await value(metrics.moderationSignalsTotal, { kind: "virtual-camera" })).toBe(1);
    expect(await value(metrics.moderationSignalsTotal, { kind: "nsfw-blur" })).toBe(1);
    expect(await value(metrics.moderationSignalsTotal, { kind: "model-unavailable" })).toBe(1);
    // virtual-camera (3, self) + nsfw-blur from the partner (2) = 5 >= 4
    expect((await s.lowPriority()).has("dev-a")).toBe(true);
    expect((await s.lowPriority()).has("dev-b")).toBe(false);
  });

  test("nudges have a per-room cooldown", () => {
    const { s } = signals();
    expect(s.shouldNudge("r1", "solicitation")).toBe(true);
    expect(s.shouldNudge("r1", "solicitation")).toBe(false);
    expect(s.shouldNudge("r1", "contact-sharing")).toBe(true);
    expect(s.shouldNudge("r2", "solicitation")).toBe(true);
  });
});
