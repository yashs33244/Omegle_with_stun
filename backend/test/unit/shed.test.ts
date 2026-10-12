import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { Counter, Registry } from "prom-client";
import {
  CLEAR_SAMPLES,
  HEAP_SHARE_OF_MEMORY,
  LOOP_DELAY_OVER_MS,
  OVER_SAMPLES,
  SHED_RETRY_AFTER_SEC,
} from "../../src/shed/constants";
import { LoadMonitor, ProcessLoadSampler, heapLimitBytes, type LoadSample } from "../../src/shed/LoadMonitor";
import { Shedder, refuseUpgrade } from "../../src/shed/Shedder";

const calm: LoadSample = { loopDelayP99Ms: 1, heapUsedBytes: 1, heapLimitBytes: 100 };
const hot: LoadSample = { ...calm, loopDelayP99Ms: LOOP_DELAY_OVER_MS + 1 };

function monitorOf(samples: LoadSample[]) {
  let i = 0;
  const changes: boolean[] = [];
  const monitor = new LoadMonitor({ sample: () => samples[Math.min(i++, samples.length - 1)]! });
  monitor.onChange((overloaded) => changes.push(overloaded));
  return { monitor, changes };
}

function shedCounter() {
  return new Counter({ name: "shed_test_total", help: "test", labelNames: ["reason"], registers: [new Registry()] });
}

async function counted(counter: Counter<"reason">, reason: string): Promise<number> {
  return (await counter.get()).values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

describe("LoadMonitor", () => {
  test("alternating hot and calm samples never flip it (a hot streak resets)", () => {
    const { monitor, changes } = monitorOf(Array.from({ length: 20 }, (_, i) => (i % OVER_SAMPLES === 0 ? calm : hot)));
    for (let i = 0; i < 20; i++) monitor.tick();
    expect(monitor.overloaded).toBe(false);
    expect(changes).toEqual([]);
  });

  test("turns on after OVER_SAMPLES hot samples and off after CLEAR_SAMPLES calm ones, notifying once each way", () => {
    const { monitor, changes } = monitorOf([...Array(OVER_SAMPLES).fill(hot), ...Array(CLEAR_SAMPLES).fill(calm)]);
    for (let i = 0; i < OVER_SAMPLES; i++) monitor.tick();
    expect(changes).toEqual([true]);
    for (let i = 1; i < CLEAR_SAMPLES; i++) monitor.tick();
    expect(monitor.overloaded).toBe(true);
    monitor.tick();
    expect(changes).toEqual([true, false]);
  });

  test("the process sampler reads a real event-loop delay and heap", async () => {
    const sampler = new ProcessLoadSampler(heapLimitBytes(undefined));
    sampler.start();
    // Real time on purpose: the histogram measures how late its own timer
    // fires, so it needs a tick armed before the stall and one after it.
    await Bun.sleep(30);
    const until = Date.now() + 60;
    while (Date.now() < until); // block the loop
    await Bun.sleep(30);
    const s = sampler.sample();
    sampler.stop();
    expect(s.loopDelayP99Ms).toBeGreaterThan(20);
    expect(s.heapUsedBytes).toBeGreaterThan(0);
    expect(s.heapLimitBytes).toBeGreaterThan(s.heapUsedBytes);
  });

  test("the heap limit is SHED_HEAP_LIMIT_MB when set, else capped by the container's memory", () => {
    expect(heapLimitBytes(256)).toBe(256 * 1024 * 1024);
    const original = process.constrainedMemory;
    try {
      process.constrainedMemory = () => 512 * 1024 * 1024;
      expect(heapLimitBytes(undefined)).toBeLessThanOrEqual(512 * 1024 * 1024 * HEAP_SHARE_OF_MEMORY);
    } finally {
      process.constrainedMemory = original;
    }
  });

  test("the heap limit reads V8's heap_size_limit from --max-old-space-size=320", () => {
    const MB = 1024 * 1024;
    // Node 22 reports old space plus young generation: 368 MB for 320.
    const flagged = 368 * MB;
    const facts = (heapSizeLimit: number, constrainedMemory: number) => ({
      heapSizeLimit: () => heapSizeLimit,
      constrainedMemory: () => constrainedMemory,
    });
    // No visible cgroup limit (Render may not expose one): V8's limit as is.
    expect(heapLimitBytes(undefined, facts(flagged, 0))).toBe(flagged);
    // A host-sized heap (no flag) on a 4 GB host shows why the flag matters.
    expect(heapLimitBytes(undefined, facts(2096 * MB, 0))).toBe(2096 * MB);
    // A visible 512 MB cgroup still caps it at its share.
    expect(heapLimitBytes(undefined, facts(flagged, 512 * MB))).toBe(512 * MB * HEAP_SHARE_OF_MEMORY);
    expect(heapLimitBytes(256, facts(flagged, 512 * MB))).toBe(256 * MB);
  });
});

describe("Shedder", () => {
  test("refuses sockets at the instance cap and sessions past the instance bucket, counting each", async () => {
    const shedTotal = shedCounter();
    let now = 0;
    const shed = new Shedder({
      maxConnectionsTotal: 2,
      sessionRateTotal: { capacity: 2, refillPerSec: 1 },
      load: { overloaded: false },
      metrics: { shedTotal },
      now: () => now,
    });
    expect(shed.admitSocket(1)).toBeNull();
    expect(shed.admitSocket(2)).toBe("server_full");
    expect([shed.takeSession(), shed.takeSession(), shed.takeSession()]).toEqual([true, true, false]);
    now += 1000;
    expect(shed.takeSession()).toBe(true);
    expect(await counted(shedTotal, "connection_cap")).toBe(1);
    expect(await counted(shedTotal, "session_rate")).toBe(1);
  });

  test("overload refuses sockets and sessions before any cap", async () => {
    const shedTotal = shedCounter();
    const load = { overloaded: true };
    const shed = new Shedder({ maxConnectionsTotal: 10, sessionRateTotal: { capacity: 10, refillPerSec: 1 }, load, metrics: { shedTotal } });
    expect(shed.admitSocket(0)).toBe("overloaded");
    expect(shed.admitSessionLoad()).toBe(false);
    load.overloaded = false;
    expect(shed.admitSessionLoad()).toBe(true);
    expect(await counted(shedTotal, "overload_socket")).toBe(1);
    expect(await counted(shedTotal, "overload_session")).toBe(1);
  });

  test("refuseUpgrade answers 503 with the reason and Retry-After, then closes", () => {
    const socket = new PassThrough();
    let written = "";
    socket.on("data", (chunk: Buffer) => (written += chunk.toString()));
    refuseUpgrade(socket as unknown as Socket, "overloaded");
    expect(written).toStartWith("HTTP/1.1 503 Service Unavailable\r\n");
    expect(written).toContain(`\r\nRetry-After: ${SHED_RETRY_AFTER_SEC}\r\n`);
    expect(written).toEndWith("\r\n\r\noverloaded");
    expect(socket.destroyed).toBe(true);
  });
});
