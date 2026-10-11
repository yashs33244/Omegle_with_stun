/**
 * Soft abuse signals (LAUNCH_PLAN LB-10, D3): a per-device risk score fed by
 * moderation signals and chat nudges, and the early-skip share (partners who
 * press Next within 3 s of call start). Crossing a threshold only lowers the
 * device's matching priority for a while. Nothing here bans or restricts.
 *
 * Redis keys (prefix "chizzy:signals:"):
 *   risk:{deviceId}     risk points; the window restarts with each new point
 *   calls:{deviceId}    hash { calls, early } (7 day TTL, refreshed on write)
 *   lowpri              zset deviceId -> low priority until (epoch ms)
 */
import type Redis from "ioredis";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { MatchMetrics } from "../match/matchMetrics";
import type { ModerationSignalPayload } from "../protocol";
import {
  CALLS_TTL_MS,
  DEDUPE_MAX,
  LOW_PRIORITY_CACHE_MS,
  LOW_PRIORITY_CAUSE,
  NUDGE_COOLDOWN_MS,
  RISK_WINDOW_MS,
  SIGNALS_KEY_PREFIX,
  SIGNAL_RISK,
  SIGNAL_TARGET,
  type LowPriorityCause,
} from "./constants";

export interface CallStats {
  calls: number;
  early: number;
}

export interface SignalStore {
  /** Adds points and returns the device's total in the current window. */
  addRisk(deviceId: string, points: number, windowMs: number): Promise<number>;
  recordCall(deviceId: string): Promise<void>;
  recordEarlySkip(deviceId: string): Promise<CallStats>;
  setLowPriority(deviceId: string, until: number): Promise<void>;
  /** Devices whose low priority lasts past `now`. */
  lowPriority(now: number): Promise<string[]>;
}

export class MemorySignalStore implements SignalStore {
  private readonly risk = new Map<string, { points: number; expiresAt: number }>();
  private readonly calls = new Map<string, CallStats>();
  private readonly low = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  async addRisk(deviceId: string, points: number, windowMs: number): Promise<number> {
    const now = this.clock();
    const current = this.risk.get(deviceId);
    const total = (current && current.expiresAt > now ? current.points : 0) + points;
    this.risk.set(deviceId, { points: total, expiresAt: now + windowMs });
    if (this.risk.size > DEDUPE_MAX) for (const [k, v] of this.risk) if (v.expiresAt <= now) this.risk.delete(k);
    return total;
  }

  async recordCall(deviceId: string): Promise<void> {
    const s = this.calls.get(deviceId) ?? { calls: 0, early: 0 };
    s.calls++;
    this.calls.set(deviceId, s);
  }

  async recordEarlySkip(deviceId: string): Promise<CallStats> {
    const s = this.calls.get(deviceId) ?? { calls: 0, early: 0 };
    s.early++;
    this.calls.set(deviceId, s);
    return { ...s };
  }

  async setLowPriority(deviceId: string, until: number): Promise<void> {
    this.low.set(deviceId, Math.max(until, this.low.get(deviceId) ?? 0));
  }

  async lowPriority(now: number): Promise<string[]> {
    const out: string[] = [];
    for (const [id, until] of this.low) {
      if (until > now) out.push(id);
      else this.low.delete(id);
    }
    return out;
  }
}

export class RedisSignalStore implements SignalStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = SIGNALS_KEY_PREFIX,
  ) {}

  async addRisk(deviceId: string, points: number, windowMs: number): Promise<number> {
    const key = `${this.prefix}risk:${deviceId}`;
    const res = await this.redis.multi().incrby(key, points).pexpire(key, windowMs).exec();
    const total = res?.[0]?.[1];
    if (typeof total !== "number") throw new Error("risk update failed");
    return total;
  }

  async recordCall(deviceId: string): Promise<void> {
    const key = `${this.prefix}calls:${deviceId}`;
    await this.redis.multi().hincrby(key, "calls", 1).pexpire(key, CALLS_TTL_MS).exec();
  }

  async recordEarlySkip(deviceId: string): Promise<CallStats> {
    const key = `${this.prefix}calls:${deviceId}`;
    const res = await this.redis.multi().hincrby(key, "early", 1).pexpire(key, CALLS_TTL_MS).hgetall(key).exec();
    const all = (res?.[2]?.[1] ?? {}) as Record<string, string>;
    return { calls: Number(all.calls ?? 0), early: Number(all.early ?? 0) };
  }

  async setLowPriority(deviceId: string, until: number): Promise<void> {
    const key = `${this.prefix}lowpri`;
    // GT: never shorten an existing low-priority window.
    await this.redis.multi().zadd(key, "GT", until, deviceId).zremrangebyscore(key, "-inf", Date.now()).exec();
  }

  async lowPriority(now: number): Promise<string[]> {
    return this.redis.zrangebyscore(`${this.prefix}lowpri`, `(${now}`, "+inf");
  }
}

export const NUDGE_RISK = { solicitation: 2, "contact-sharing": 1 } as const;

export interface SafetySignalsDeps {
  store: SignalStore;
  config: Config;
  logger: Logger;
  metrics: Pick<MatchMetrics, "earlySkipsTotal" | "lowPriorityTotal" | "moderationSignalsTotal">;
  now?: () => number;
}

export class SafetySignals {
  private readonly store: SignalStore;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly metrics: SafetySignalsDeps["metrics"];
  private readonly now: () => number;
  private lowCache: { at: number; set: Set<string> } | null = null;
  private readonly seenSignals = new Set<string>();
  private readonly nudgedAt = new Map<string, number>();

  constructor(deps: SafetySignalsDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.log = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  /** Low-priority devices, cached briefly so match passes do not hit the store each time. */
  async lowPriority(): Promise<Set<string>> {
    const now = this.now();
    if (this.lowCache && now - this.lowCache.at < LOW_PRIORITY_CACHE_MS) return this.lowCache.set;
    try {
      this.lowCache = { at: now, set: new Set(await this.store.lowPriority(now)) };
    } catch (err) {
      // Priority is a nicety: on a store error match everyone normally.
      this.log.warn({ err }, "low priority lookup failed");
      this.lowCache = { at: now, set: new Set() };
    }
    return this.lowCache.set;
  }

  /** Both devices of a call that just started. */
  callStarted(devices: readonly string[]): void {
    for (const d of devices) this.background(this.store.recordCall(d), "record call");
  }

  /** `skipped` was skipped by its partner `msSinceStart` after the call started. */
  skipped(skipped: string, msSinceStart: number): void {
    if (msSinceStart > this.config.earlySkipMs) return;
    this.metrics.earlySkipsTotal.inc();
    this.background(
      this.store.recordEarlySkip(skipped).then(async (s) => {
        if (s.calls >= this.config.earlySkipMinCalls && s.early / s.calls >= this.config.earlySkipShare) {
          await this.markLow(skipped, LOW_PRIORITY_CAUSE.earlySkip);
        }
      }),
      "early skip",
    );
  }

  /**
   * A moderation signal from `self` about a room with `partner` (null when the
   * room is gone). Counted once per socket, room and kind.
   */
  moderationSignal(socketId: string, roomId: string, kind: ModerationSignalPayload["kind"], self: string, partner: string | null): void {
    if (!this.firstTime(`${socketId}:${roomId}:${kind}`)) return;
    this.metrics.moderationSignalsTotal.inc({ kind });
    const rule = SIGNAL_RISK[kind];
    const target = rule.against === SIGNAL_TARGET.self ? self : partner;
    if (rule.points > 0 && target) this.addRisk(target, rule.points, kind);
  }

  addRisk(deviceId: string, points: number, cause: string): void {
    this.background(
      this.store.addRisk(deviceId, points, RISK_WINDOW_MS).then(async (total) => {
        if (total >= this.config.riskThreshold) await this.markLow(deviceId, LOW_PRIORITY_CAUSE.risk);
      }),
      `risk ${cause}`,
    );
  }

  /** At most one nudge of a kind per room per minute (both sides may chat on different instances). */
  shouldNudge(roomId: string, kind: string): boolean {
    const now = this.now();
    const key = `${roomId}:${kind}`;
    const last = this.nudgedAt.get(key);
    if (last !== undefined && now - last < NUDGE_COOLDOWN_MS) return false;
    if (this.nudgedAt.size > DEDUPE_MAX) {
      for (const [k, t] of this.nudgedAt) if (now - t >= NUDGE_COOLDOWN_MS) this.nudgedAt.delete(k);
    }
    this.nudgedAt.set(key, now);
    return true;
  }

  private firstTime(key: string): boolean {
    if (this.seenSignals.has(key)) return false;
    if (this.seenSignals.size >= DEDUPE_MAX) this.seenSignals.clear();
    this.seenSignals.add(key);
    return true;
  }

  private async markLow(deviceId: string, cause: LowPriorityCause): Promise<void> {
    const already = (await this.lowPriority()).has(deviceId);
    await this.store.setLowPriority(deviceId, this.now() + this.config.lowPriorityMs);
    this.lowCache?.set.add(deviceId);
    if (!already) {
      this.metrics.lowPriorityTotal.inc({ cause });
      this.log.info({ cause }, "device given low matching priority");
    }
  }

  private background(p: Promise<unknown>, what: string): void {
    p.catch((err: unknown) => this.log.warn({ err, what }, "safety signal update failed"));
  }
}
