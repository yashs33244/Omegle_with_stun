/**
 * Operator flags (the kill switch). Stored as one hash (Redis) or object (memory),
 * validated with the protocol's flagsSchema, read through a per-instance cache so
 * hot paths never wait on the store.
 */
import type Redis from "ioredis";
import { FLAG_DEFAULTS, flagsSchema, type Flags } from "../protocol";

export interface FlagsStore {
  /** Stored overrides merged over FLAG_DEFAULTS. */
  get(): Promise<Flags>;
  /** Validates and stores a partial update; returns the merged result. */
  set(patch: Partial<Flags>): Promise<Flags>;
}

const DEFAULTS: Flags = { ...FLAG_DEFAULTS };

function merge(stored: Partial<Flags>): Flags {
  const merged = { ...DEFAULTS, ...stored };
  const parsed = flagsSchema.safeParse(merged);
  // A bad stored value falls back to the default for safety rather than crashing readers.
  if (parsed.success) return parsed.data;
  const clean: Record<string, unknown> = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Flags)[]) {
    const one = flagsSchema.shape[key].safeParse(merged[key]);
    if (one.success) clean[key] = one.data;
  }
  return clean as Flags;
}

function validatePatch(patch: Partial<Flags>): Partial<Flags> {
  return flagsSchema.partial().strict().parse(patch);
}

export class MemoryFlagsStore implements FlagsStore {
  private stored: Partial<Flags> = {};

  async get(): Promise<Flags> {
    return merge(this.stored);
  }

  async set(patch: Partial<Flags>): Promise<Flags> {
    this.stored = { ...this.stored, ...validatePatch(patch) };
    return merge(this.stored);
  }
}

export class RedisFlagsStore implements FlagsStore {
  constructor(
    private readonly redis: Redis,
    private readonly key = "chizzy:flags",
  ) {}

  async get(): Promise<Flags> {
    const raw = await this.redis.hgetall(this.key);
    const stored: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      try {
        stored[k] = JSON.parse(v);
      } catch {
        // ignore unparseable values; merge() falls back to defaults
      }
    }
    return merge(stored as Partial<Flags>);
  }

  async set(patch: Partial<Flags>): Promise<Flags> {
    const valid = validatePatch(patch);
    const entries = Object.entries(valid).flatMap(([k, v]) => [k, JSON.stringify(v)]);
    if (entries.length) await this.redis.hset(this.key, ...entries);
    return this.get();
  }
}

export interface MatchingStatus {
  open: boolean;
  /** Epoch ms of the next opening when closed by staffed hours; null otherwise. */
  reopensAt: number | null;
  message: string | null;
}

/** Minutes since local midnight in `timeZone` for the instant `ms`. */
function localMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

interface Window {
  start: number;
  end: number;
  timeZone: string;
}

/** Parses "HH:MM-HH:MM Area/City". "24:00" means midnight at the end of the day. */
export function parseStaffedHours(value: string): Window | null {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2}) ([A-Za-z_]+\/[A-Za-z_]+)$/.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start > 24 * 60 || end > 24 * 60 || start === end) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: m[5] });
  } catch {
    return null;
  }
  return { start, end, timeZone: m[5]! };
}

function clockLabel(minutes: number): string {
  if (minutes === 0 || minutes === 24 * 60) return "midnight";
  if (minutes === 12 * 60) return "noon";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** "20:00-24:00 Asia/Kolkata" -> "8 pm to midnight (Asia/Kolkata)"; null when empty or invalid. */
export function describeStaffedHours(value: string): string | null {
  const w = value ? parseStaffedHours(value) : null;
  return w ? `${clockLabel(w.start)} to ${clockLabel(w.end)} (${w.timeZone})` : null;
}

function insideWindow(w: Window, minutes: number): boolean {
  return w.start < w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
}

export function matchingStatus(flags: Flags, now: number): MatchingStatus {
  if (!flags.matching_enabled) {
    return { open: false, reopensAt: null, message: flags.banner_message || "Matching is paused right now." };
  }
  const window = flags.staffed_hours ? parseStaffedHours(flags.staffed_hours) : null;
  if (!window || insideWindow(window, localMinutes(now, window.timeZone))) {
    return { open: true, reopensAt: null, message: null };
  }
  // Find the next opening minute (at most a day ahead).
  const startOfMinute = now - (now % 60_000);
  let reopensAt: number | null = null;
  for (let i = 1; i <= 24 * 60; i++) {
    const t = startOfMinute + i * 60_000;
    if (insideWindow(window, localMinutes(t, window.timeZone))) {
      reopensAt = t;
      break;
    }
  }
  return { open: false, reopensAt, message: null };
}

/**
 * Cached view of the flags for hot paths. `current()` is synchronous and never
 * older than `ttlMs` after the first refresh; call `start()` once at boot.
 */
export class FlagsReader {
  private value: Flags = { ...DEFAULTS };
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(flags: Flags, previous: Flags) => void>();

  constructor(
    readonly store: FlagsStore,
    private readonly ttlMs = 2_000,
  ) {}

  current(): Flags {
    return this.value;
  }

  status(now = Date.now()): MatchingStatus {
    return matchingStatus(this.value, now);
  }

  /** Called after every refresh that changed something. */
  onChange(listener: (flags: Flags, previous: Flags) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<Flags> {
    const next = await this.store.get();
    const previous = this.value;
    this.value = next;
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      for (const l of this.listeners) l(next, previous);
    }
    return next;
  }

  /** Writes through the store and refreshes the cache at once. */
  async set(patch: Partial<Flags>): Promise<Flags> {
    await this.store.set(patch);
    return this.refresh();
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer ??= setInterval(() => {
      this.refresh().catch(() => undefined);
    }, this.ttlMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
