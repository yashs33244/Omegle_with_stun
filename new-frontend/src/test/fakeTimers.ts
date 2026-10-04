import type { Timers } from "@/lib/connectivity";

/** Deterministic timers for the connectivity and moderation loops: advance() runs whatever is due, in order. */
export function fakeTimers(start = 1_000) {
  let now = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      pending.delete(h as number);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  /** Advances in small steps and lets promise callbacks run in between. */
  const advanceAsync = async (ms: number, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      advance(Math.min(step, ms - t));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  };
  return { timers, advance, advanceAsync, pendingCount: () => pending.size };
}
