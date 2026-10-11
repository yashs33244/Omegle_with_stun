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
 * With several instances only the one holding a short Redis lock polls.
 */
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { FlagsReader } from "../flags/flags";
import type { Logger } from "../logger";
import type { MatchMetrics } from "../match/matchMetrics";
import type { Flags } from "../protocol";
import type { FetchFn } from "./cloudflare";

export const RELAY_STEP_DOWN_KBPS = 300;
const GB = 1e9;

/** Returns TURN egress bytes between `start` (inclusive) and `end`. */
export type EgressQuery = (start: Date, end: Date) => Promise<number>;

export const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Cloudflare Realtime TURN analytics. Dataset and field names follow the
 * Cloudflare GraphQL schema for Realtime (Calls) TURN usage; verify them with
 * the GraphQL explorer on the production account before relying on the cap.
 */
export const TURN_EGRESS_QUERY = `query TurnEgress($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { datetimeMinute_geq: $start, datetimeMinute_lt: $end }) {
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
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`cloudflare graphql returned ${res.status}`);
    return parseEgressResponse((await res.json()) as GraphqlResponse);
  };
}

interface Step {
  name: string;
  /** True when the flags already reflect this step. */
  applied(f: Flags): boolean;
  patch: Partial<Flags>;
}

const STEPS: Step[] = [
  {
    name: "relay-bitrate",
    applied: (f) => f.relay_video_max_kbps <= RELAY_STEP_DOWN_KBPS,
    patch: { relay_video_max_kbps: RELAY_STEP_DOWN_KBPS },
  },
  { name: "private-mode-off", applied: (f) => !f.private_mode_enabled, patch: { private_mode_enabled: false } },
  { name: "turn-off", applied: (f) => !f.turn_enabled, patch: { turn_enabled: false } },
];

export interface SpendPollerDeps {
  flags: FlagsReader;
  query: EgressQuery;
  /** Three ascending daily thresholds in GB. */
  thresholdsGb: [number, number, number];
  intervalMs: number;
  logger: Logger;
  metrics: Pick<MatchMetrics, "turnSpendStepsTotal" | "turnSpendPollErrorsTotal" | "turnEgressGbToday">;
  /** Shared Redis client; when present only the lock holder polls. */
  redis?: Redis;
  lockKey?: string;
  now?: () => number;
}

export type PollResult =
  | { status: "skipped" }
  | { status: "error" }
  | { status: "ok"; gb: number; applied: string[] };

export class TurnSpendPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<PollResult>;
  private readonly now: () => number;

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
      const dayStart = new Date(now - (now % 86_400_000));
      const bytes = await deps.query(dayStart, new Date(now));
      const gb = bytes / GB;
      deps.metrics.turnEgressGbToday.set(gb);
      const applied: string[] = [];
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
      return { status: "error" };
    }
  }

  /** A lease just under the poll interval, never released, so one instance polls per interval. */
  private async acquire(): Promise<boolean> {
    if (!this.deps.redis) return true;
    const ttl = Math.max(1_000, Math.floor(this.deps.intervalMs * 0.9));
    const res = await this.deps.redis.set(this.deps.lockKey ?? "chizzy:lock:turn-spend", randomUUID(), "PX", ttl, "NX");
    return res === "OK";
  }
}
