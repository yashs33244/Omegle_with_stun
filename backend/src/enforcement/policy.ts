/**
 * Pure enforcement rules: severity, SLA clocks, the restriction ladder,
 * reporter weighting, auto-pause thresholds and CSAM routing. The numbers
 * live in constants.ts. No I/O here, so every rule is unit tested directly
 * (test/unit/enforcementPolicy.test.ts).
 */
import type { ReportReason, Restriction, RestrictionReason, Severity, TakedownRequest } from "../protocol";
import {
  ACK_SLA_MS,
  DAY,
  DISMISSED_FOR_ZERO_WEIGHT,
  FULL_WEIGHT_AGE_HOURS,
  FULL_WEIGHT_CALLS,
  HOUR,
  LADDER,
  MINOR_THRESHOLD,
  NEUTRAL_UPHELD_SHARE,
  NSFW_THRESHOLD,
  REPORTER_WEIGHT,
  RESOLVE_SLA_MS,
  TAKEDOWN_SLA_MS,
  UPHELD_SHARE_FLOOR,
  URGENT_RESOLVE_SLA_MS,
  WARNING_STEP,
  WEIGHT_DECIMALS,
  type LadderStep,
} from "./constants";
import type { DeviceStats } from "./types";

const REASON_RANK: Record<ReportReason, number> = {
  underage: 0,
  nudity: 1,
  harassment: 2,
  hate: 2,
  violence: 2,
  inappropriate: 3,
  spam: 4,
  fake: 4,
  other: 5,
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function severityOf(reason: ReportReason, restricted: boolean): Severity {
  if (restricted || reason === "underage") return "critical";
  if (reason === "nudity") return "high";
  if (reason === "harassment" || reason === "hate" || reason === "violence" || reason === "inappropriate") {
    return "medium";
  }
  return "low";
}

/** Queue order: minor > nudity > harassment/hate/violence > spam/fake > other. */
export function queueRank(reason: ReportReason, restricted: boolean): [number, number] {
  return [SEVERITY_RANK[severityOf(reason, restricted)], restricted ? -1 : REASON_RANK[reason]];
}

/** SLA clocks: acknowledge within 24 h; resolve within 72 h for nudity or minors, 15 days otherwise. */
export function reportSla(reason: ReportReason, restricted: boolean, createdAt: number) {
  const urgent = restricted || reason === "nudity" || reason === "underage";
  return { ackDueAt: createdAt + ACK_SLA_MS, resolveDueAt: createdAt + (urgent ? URGENT_RESOLVE_SLA_MS : RESOLVE_SLA_MS) };
}

/** Takedown clocks: 24 h for CSAM, 48 h for NCII (TAKE IT DOWN Act), 15 days otherwise. */
export function takedownDueAt(kind: TakedownRequest["kind"], createdAt: number): number {
  return createdAt + TAKEDOWN_SLA_MS[kind];
}

export function restrictionReasonFor(reason: ReportReason, restricted: boolean): RestrictionReason {
  if (restricted && reason !== "underage") return "minor-safety";
  switch (reason) {
    case "fake":
      return "fake-video";
    case "inappropriate":
      return "other";
    default:
      return reason;
  }
}

/** Evidence is never shown back for minor-safety, nudity or CSAM-routed items. */
export function evidenceShowable(reason: RestrictionReason, hasFrame: boolean, restricted: boolean): boolean {
  return hasFrame && !restricted && reason !== "nudity" && reason !== "minor-safety" && reason !== "underage";
}

/** Short restrictions are pauses; a day or more, or permanent, is a ban. */
export function kindFor(durationMs: number | null): Restriction["kind"] {
  return durationMs !== null && durationMs < DAY ? "pause" : "ban";
}

/**
 * Next human step on the ladder. `confirmed` counts earlier human actions on the
 * device (warnings included) that were not overturned. `warn` always warns;
 * `restrict` starts at 10 min.
 */
export function ladderStep(action: "warn" | "restrict", confirmed: number): LadderStep {
  if (action === "warn") return WARNING_STEP;
  return LADDER[Math.min(Math.max(confirmed, 1), LADDER.length - 1)]!;
}

/**
 * Reporter weight in [0, 1] from device age, completed calls and the share of
 * past reports an admin upheld. Everyone passes Turnstile, so no single signal
 * dominates. Reporters whose reports keep getting dismissed weigh 0.
 */
export function reporterWeight(stats: DeviceStats, now: number): number {
  const decided = stats.upheld + stats.dismissed;
  const upheldShare = decided > 0 ? stats.upheld / decided : NEUTRAL_UPHELD_SHARE;
  if (stats.dismissed >= DISMISSED_FOR_ZERO_WEIGHT && upheldShare < UPHELD_SHARE_FLOOR) return 0;
  const ageHours = stats.firstSeen === null ? 0 : Math.max(0, now - stats.firstSeen) / HOUR;
  const age = Math.min(1, ageHours / FULL_WEIGHT_AGE_HOURS);
  const calls = Math.min(1, stats.completedCalls / FULL_WEIGHT_CALLS);
  const w =
    REPORTER_WEIGHT.base + REPORTER_WEIGHT.age * age + REPORTER_WEIGHT.calls * calls + REPORTER_WEIGHT.upheld * upheldShare;
  const scale = 10 ** WEIGHT_DECIMALS;
  return Math.round(Math.min(1, Math.max(0, w)) * scale) / scale;
}

/** Weight of one report: the reporter's weight, halved for calls under SHORT_CALL_MS. */
export function reportWeight(weight: number, shortCall: boolean): number {
  return shortCall ? weight / 2 : weight;
}

export interface FrameScores {
  /** 0..1, how likely the frame shows nudity or sexual content. */
  nsfw: number;
  /** 0..1, how likely the frame shows a minor. */
  minor: number;
}

/** Optional server-side classifier hook (none ships in v1). Must not throw on bad input. */
export type FrameClassifier = (jpeg: Uint8Array) => Promise<FrameScores | null>;

/**
 * Routes a report to the restricted (suspected CSAM) path when:
 * - the reason is underage; or
 * - the reason is nudity and anything points to a minor (classifier, a minor
 *   flag on the device, or an earlier underage report against it); or
 * - the classifier says the frame is both NSFW and possibly a minor, whatever the reason.
 */
export function routeRestricted(input: {
  reason: ReportReason;
  scores: FrameScores | null;
  minorSignal: boolean;
}): boolean {
  const { reason, scores } = input;
  if (reason === "underage") return true;
  const minorFromFrame = scores !== null && scores.minor >= MINOR_THRESHOLD;
  if (reason === "nudity" && (minorFromFrame || input.minorSignal)) return true;
  return scores !== null && scores.nsfw >= NSFW_THRESHOLD && minorFromFrame;
}
