/**
 * TURN spend cap (LAUNCH_PLAN LB-8). The TURN bill is on Cloudflare, so AWS
 * budget alarms never see it. Every 15 minutes this reads today's TURN egress
 * (UTC day) from Cloudflare's GraphQL analytics and, at three daily GB
 * thresholds, steps down through the flags:
 *   1. relay_video_max_kbps -> 300
 *   2. private_mode_enabled -> false (Hide my IP off)
 *   3. turn_enabled -> false (STUN only)
 * Each step logs an error (alerting hooks on error logs) and increments
 * chizzy_turn_spend_steps_total. Steps never undo themselves: an operator
 * restores the flags from the admin API once the spike is understood.
 *
 * Fails closed: after SPEND_FAILSAFE_AFTER_FAILURES polls in a row fail (1 h
 * at the 15 min interval) the spend is unknown, so the poller applies the
 * failsafe steps (1 and 2: relay bitrate down, Hide my IP off; TURN itself
 * stays on, calls behind strict NATs still connect) on every failed poll
 * until one succeeds. Entering that state logs an error and increments
 * chizzy_turn_spend_failsafe_total.
 *
 * With several instances only the one holding a short Redis lock polls; the
 * failure streak is shared through Redis so it counts polls, not instances.
 */
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { MatchMetrics } from "../match/matchMetrics";
import type { Flags } from "../protocol";
import type { FetchFn } from "./cloudflare";
import {
  BYTES_PER_GB,
  CLOUDFLARE_GRAPHQL_GROUP_LIMIT,
  CLOUDFLARE_GRAPHQL_TIMEOUT_MS,
  CLOUDFLARE_GRAPHQL_URL,
  DAY_MS,
  RELAY_STEP_DOWN_KBPS,
  SPEND_FAILSAFE_AFTER_FAILURES,
  SPEND_FAILURES_KEY,
  SPEND_LOCK_KEY,
  SPEND_LOCK_LEASE_SHARE,
  SPEND_LOCK_MIN_TTL_MS,
  SPEND_STEP,
  type SpendStep,
} from "./constants";

/** Returns TURN egress bytes between `start` (inclusive) and `end`. */
export type EgressQuery = (start: Date, end: Date) => Promise<number>;

/**
 * Cloudflare Realtime TURN analytics. Dataset and field names follow the
 * Cloudflare GraphQL schema for Realtime (Calls) TURN usage; verify them with
 * the GraphQL explorer on the production account before relying on the cap.
 */
export const TURN_EGRESS_QUERY = `query TurnEgress($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      callsTurnUsageAdaptiveGroups(limit: ${CLOUDFLARE_GRAPHQL_GROUP_LIMIT}, filter: { datetimeMinute_geq: $start, datetimeMinute_lt: $end }) {
        sum { egressBytes }
      }
    }
  }
}`;

interface GraphqlResponse {
  data?: {
    viewer?: {
      accounts?: Array<{ callsTurnUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: unknown } }> }>;
    };
  } | null;
  errors?: Array<{ message?: string }> | null;
}

/** Sums egress bytes from a GraphQL response; throws on errors or an unexpected shape. */
export function parseEgressResponse(body: GraphqlResponse): number {
  if (body.errors && body.errors.length > 0) {
    throw new Error(`cloudflare graphql error: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`);
  }
  const accounts = body.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("cloudflare graphql: no account in response");
  let total = 0;
  for (const group of accounts[0]!.callsTurnUsageAdaptiveGroups ?? []) {
    const bytes = group.sum?.egressBytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) throw new Error("cloudflare graphql: bad egressBytes");
    total += bytes;
  }
  return total;
}

export function cloudflareEgressQuery(opts: { accountId: string; apiToken: string; fetch: FetchFn }): EgressQuery {
  return async (start, end) => {
    const res = await opts.fetch(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: TURN_EGRESS_QUERY,
        variables: { accountTag: opts.accountId, start: start.toISOString(), end: end.toISOString() },
      }),
      signal: AbortSignal.timeout(CLOUDFLARE_GRAPHQL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`cloudflare graphql returned ${res.status}`);
    return parseEgressResponse((await res.json()) as GraphqlResponse);
  };
}

interface Step {
  name: SpendStep;
  /** True when the flags already reflect this step. */
  applied(f: Flags): boolean;
  patch: Partial<Flags>;
  /** Applied blind when the analytics have been failing for an hour. */
  failsafe: boolean;
}

const STEPS: Step[] = [
  {
    name: SPEND_STEP.relayBitrate,
    applied: (f) => f.relay_video_max_kbps <= RELAY_STEP_DOWN_KBPS,
    patch: { relay_video_max_kbps: RELAY_STEP_DOWN_KBPS },
    failsafe: true,
  },
  {
    name: SPEND_STEP.privateModeOff,
    applied: (f) => !f.private_mode_enabled,
    patch: { private_mode_enabled: false },
    failsafe: true,
  },
  { name: SPEND_STEP.turnOff, applied: (f) => !f.turn_enabled, patch: { turn_enabled: false }, failsafe: false },
];

export interface SpendPollerDeps {
  flags: FlagsReader;
  query: EgressQuery;
  /** Three ascending daily thresholds in GB. */
  thresholdsGb: [number, number, number];
  intervalMs: number;
  logger: Logger;
  metrics: Pick<
    MatchMetrics,
    "turnSpendStepsTotal" | "turnSpendPollErrorsTotal" | "turnSpendFailsafeTotal" | "turnEgressGbToday"
  >;
  /** Shared Redis client; when present only the lock holder polls. */
  redis?: Redis;
  lockKey?: string;
  /** Redis key of the shared failure streak. */
  failuresKey?: string;
  now?: () => number;
}

export type PollResult =
  | { status: "skipped" }
  /** `applied`: failsafe steps taken on this poll, present once the failure streak reached the failsafe. */
  | { status: "error"; applied?: string[] }
  | { status: "ok"; gb: number; applied: string[] };

export class TurnSpendPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<PollResult>;
  private readonly now: () => number;
  /** Failed polls in a row on this instance (the fallback when Redis is unreachable). */
  private failures = 0;
  /** The failsafe has engaged during the current failure streak. */
  private failsafeEngaged = false;

  constructor(private readonly deps: SpendPollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.deps.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll; overlapping calls share the run in progress. Never throws. */
  poll(): Promise<PollResult> {
    this.running ??= this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<PollResult> {
    const { deps } = this;
    try {
      if (!(await this.acquire())) return { status: "skipped" };
      const now = this.now();
      const dayStart = new Date(now - (now % DAY_MS));
      const bytes = await deps.query(dayStart, new Date(now));
      const gb = bytes / BYTES_PER_GB;
      await this.recovered();
      deps.metrics.turnEgressGbToday.set(gb);
      const applied: SpendStep[] = [];
      for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i]!;
        if (gb < deps.thresholdsGb[i]!) break;
        // Re-read the cache each time: the previous step changed it.
        if (step.applied(deps.flags.current())) continue;
        await deps.flags.set(step.patch);
        applied.push(step.name);
        deps.metrics.turnSpendStepsTotal.inc({ step: step.name });
        deps.logger.error(
          { step: step.name, egressGb: Number(gb.toFixed(2)), thresholdGb: deps.thresholdsGb[i] },
          "TURN spend threshold reached; stepping down",
        );
      }
      return { status: "ok", gb, applied };
    } catch (err) {
      deps.metrics.turnSpendPollErrorsTotal.inc();
      deps.logger.error({ err }, "TURN spend poll failed");
      const streak = await this.failureStreak();
      if (streak < SPEND_FAILSAFE_AFTER_FAILURES) return { status: "error" };
      return { status: "error", applied: await this.failsafe(streak) };
    }
  }

  /** Counts one failed poll; returns the longer of the shared and the local streak. */
  private async failureStreak(): Promise<number> {
    this.failures++;
    const { redis } = this.deps;
    if (!redis) return this.failures;
    try {
      const key = this.deps.failuresKey ?? SPEND_FAILURES_KEY;
      // Outlives a few missed polls, so a streak from last week never counts.
      const ttl = (SPEND_FAILSAFE_AFTER_FAILURES + 1) * this.deps.intervalMs;
      const res = await redis.multi().incr(key).pexpire(key, ttl).exec();
      const shared = Number(res?.[0]?.[1]);
      return Number.isFinite(shared) ? Math.max(shared, this.failures) : this.failures;
    } catch {
      return this.failures;
    }
  }

  /** A poll succeeded: the streak ends (steps already taken stay, like threshold steps). */
  private async recovered(): Promise<void> {
    if (this.failsafeEngaged) {
      this.deps.logger.warn("TURN spend poll recovered; failsafe step-downs stay until an operator restores them");
    }
    this.failures = 0;
    this.failsafeEngaged = false;
    if (!this.deps.redis) return;
    // A leftover shared streak only makes the next outage engage the failsafe sooner.
    await this.deps.redis.del(this.deps.failuresKey ?? SPEND_FAILURES_KEY).catch((err: unknown) => {
      this.deps.logger.warn({ err }, "could not reset the TURN spend failure streak");
    });
  }

  /** Spend unknown for too long: apply the failsafe steps. Never throws. */
  private async failsafe(streak: number): Promise<SpendStep[]> {
    const { deps } = this;
    if (!this.failsafeEngaged) {
      this.failsafeEngaged = true;
      deps.metrics.turnSpendFailsafeTotal.inc();
      deps.logger.error({ failedPolls: streak }, "TURN spend unknown; applying the failsafe step-downs until a poll succeeds");
    }
    const applied: SpendStep[] = [];
    try {
      for (const step of STEPS) {
        if (!step.failsafe || step.applied(deps.flags.current())) continue;
        await deps.flags.set(step.patch);
        applied.push(step.name);
        deps.metrics.turnSpendStepsTotal.inc({ step: step.name });
        deps.logger.error({ step: step.name, failedPolls: streak }, "TURN spend unknown; stepping down");
      }
    } catch (err) {
      deps.logger.error({ err }, "TURN spend failsafe could not update the flags");
    }
    return applied;
  }

  /** A lease just under the poll interval, never released, so one instance polls per interval. */
  private async acquire(): Promise<boolean> {
    if (!this.deps.redis) return true;
    const ttl = Math.max(SPEND_LOCK_MIN_TTL_MS, Math.floor(this.deps.intervalMs * SPEND_LOCK_LEASE_SHARE));
    const res = await this.deps.redis.set(this.deps.lockKey ?? SPEND_LOCK_KEY, randomUUID(), "PX", ttl, "NX");
    return res === "OK";
  }
}
