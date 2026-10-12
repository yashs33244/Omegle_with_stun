/**
 * Decides whether this process is overloaded from two cheap signals sampled
 * once per LOAD_SAMPLE_INTERVAL_MS: the event-loop delay p99 over the last
 * interval and the V8 heap in use against its limit. OVER_SAMPLES hot
 * samples in a row turn it on; CLEAR_SAMPLES calm samples in a row (below
 * lower marks) turn it off again. The sampler is injected so tests can force
 * either state and step it with tick().
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import {
  CLEAR_SAMPLES,
  HEAP_CLEAR_RATIO,
  HEAP_OVER_RATIO,
  HEAP_SHARE_OF_MEMORY,
  LOOP_DELAY_CLEAR_MS,
  LOOP_DELAY_OVER_MS,
  LOOP_DELAY_RESOLUTION_MS,
  OVER_SAMPLES,
} from "./constants";

export interface LoadSample {
  /** Event-loop delay p99 since the previous sample. */
  loopDelayP99Ms: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
}

export interface LoadSampler {
  sample(): LoadSample;
  /** Called by LoadMonitor.start/stop; a sampler with state to arm (a histogram) implements them. */
  start?(): void;
  stop?(): void;
}

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

/** Where heapLimitBytes reads V8's limit and the container's memory; injectable for tests. */
export interface HeapFacts {
  /** v8.getHeapStatistics().heap_size_limit: old space (--max-old-space-size) plus young generation. */
  heapSizeLimit(): number;
  /** process.constrainedMemory(): the cgroup limit, or 0 / the host's memory without one. */
  constrainedMemory(): number;
}

const processHeapFacts: HeapFacts = {
  heapSizeLimit: () => getHeapStatistics().heap_size_limit,
  constrainedMemory: () => process.constrainedMemory?.() ?? 0,
};

/**
 * The heap budget shedding compares against: SHED_HEAP_LIMIT_MB when set,
 * else V8's limit capped at HEAP_SHARE_OF_MEMORY of the container's memory.
 * process.constrainedMemory() is 0 (Node) or the host's memory (Bun) outside
 * a cgroup limit, so the min() leaves V8's limit in place there. The
 * deployments set NODE_OPTIONS=--max-old-space-size=320 (render.yaml,
 * docker-compose.yml), so V8's limit is about 368 MB even where the cgroup
 * limit is not visible to the process.
 */
export function heapLimitBytes(limitMb: number | undefined, facts: HeapFacts = processHeapFacts): number {
  if (limitMb !== undefined) return limitMb * BYTES_PER_MB;
  const v8Limit = facts.heapSizeLimit();
  const container = facts.constrainedMemory();
  return container > 0 ? Math.min(v8Limit, container * HEAP_SHARE_OF_MEMORY) : v8Limit;
}

/** The real sampler: perf_hooks event-loop delay histogram and v8 heap statistics. */
export class ProcessLoadSampler implements LoadSampler {
  private histogram: IntervalHistogram | undefined;

  constructor(private readonly limitBytes: number) {}

  start(): void {
    this.histogram ??= monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
    this.histogram.enable();
  }

  stop(): void {
    this.histogram?.disable();
  }

  sample(): LoadSample {
    const h = this.histogram;
    // percentile() is NaN-free but 0 with no samples, i.e. a loop too busy to
    // tick even once; the next sample then sees the whole stall.
    const loopDelayP99Ms = h ? h.percentile(99) / NS_PER_MS : 0;
    h?.reset();
    return { loopDelayP99Ms, heapUsedBytes: getHeapStatistics().used_heap_size, heapLimitBytes: this.limitBytes };
  }
}

export class LoadMonitor {
  private state = false;
  private streak = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners: ((overloaded: boolean, sample: LoadSample) => void)[] = [];

  constructor(private readonly sampler: LoadSampler) {}

  get overloaded(): boolean {
    return this.state;
  }

  /** Called on every state change (not on every sample). */
  onChange(fn: (overloaded: boolean, sample: LoadSample) => void): void {
    this.listeners.push(fn);
  }

  /** Takes one sample and updates the state. The interval calls it; tests call it directly. */
  tick(): void {
    const s = this.sampler.sample();
    const heap = s.heapLimitBytes > 0 ? s.heapUsedBytes / s.heapLimitBytes : 0;
    // While calm, count hot samples; while overloaded, count calm ones.
    const counts = this.state
      ? s.loopDelayP99Ms < LOOP_DELAY_CLEAR_MS && heap < HEAP_CLEAR_RATIO
      : s.loopDelayP99Ms > LOOP_DELAY_OVER_MS || heap > HEAP_OVER_RATIO;
    this.streak = counts ? this.streak + 1 : 0;
    if (this.streak < (this.state ? CLEAR_SAMPLES : OVER_SAMPLES)) return;
    this.state = !this.state;
    this.streak = 0;
    for (const fn of this.listeners) fn(this.state, s);
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.sampler.start?.();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.sampler.stop?.();
  }
}
