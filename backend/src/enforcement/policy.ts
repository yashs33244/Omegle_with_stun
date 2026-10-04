/**
 * Pure enforcement rules: severity, SLA clocks, the restriction ladder,
 * reporter weighting, auto-pause thresholds and CSAM routing.
 * No I/O here, so every rule is unit tested directly (test/unit/enforcementPolicy.test.ts).
 */
import type { ReportReason, Restriction, RestrictionReason, Severity, TakedownRequest } from "../protocol";
import type { DeviceStats } from "./types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

/** The only automatic, report-driven action: a short pause. */
export const AUTO_PAUSE_MS = 10 * MINUTE;

/** Human ladder: warning, 10 min, 24 h, 7 days, permanent (null). */
export const LADDER: readonly (number | null | "warning")[] = ["warning", 10 * MINUTE, DAY, 7 * DAY, null];

/** Reports per device per hour. */
export const REPORTS_PER_HOUR = 5;
/** Weighted reports against a device within this window count toward an auto pause. */
export const AUTO_PAUSE_WINDOW_MS = DAY;
/** Sum of reporter weights that triggers an auto pause. Fresh devices weigh about 0.23, so it takes 8 of them. */
export const AUTO_PAUSE_THRESHOLD = 1.6;
/** A reporter at or above this weight corroborates an underage report alone. */
export const HIGH_WEIGHT = 0.7;
/** Calls shorter than this carry half weight. */
export const SHORT_CALL_MS = 2_000;
/** A call at least this long counts as completed for the reporter weight. */
export const COMPLETED_CALL_MS = 30_000;
/** A second underage report within this window corroborates the first. */
export const UNDERAGE_CORROBORATION_WINDOW_MS = 7 * DAY;

/** Classifier thresholds for CSAM routing. */
export const NSFW_THRESHOLD = 0.7;
export const MINOR_THRESHOLD = 0.5;

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
  return { ackDueAt: createdAt + DAY, resolveDueAt: createdAt + (urgent ? 3 * DAY : 15 * DAY) };
}

/** Takedown clocks: 24 h for CSAM, 48 h for NCII (TAKE IT DOWN Act), 15 days otherwise. */
export function takedownDueAt(kind: TakedownRequest["kind"], createdAt: number): number {
  if (kind === "csam") return createdAt + DAY;
  if (kind === "ncii") return createdAt + 2 * DAY;
  return createdAt + 15 * DAY;
}

/** Appeals have a 48 h target. */
export const APPEAL_DUE_MS = 2 * DAY;

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
export function ladderStep(action: "warn" | "restrict", confirmed: number): number | null | "warning" {
  if (action === "warn") return "warning";
  return LADDER[Math.min(Math.max(confirmed, 1), LADDER.length - 1)]!;
}

/**
 * Reporter weight in [0, 1] from device age, completed calls and the share of
 * past reports an admin upheld. Everyone passes Turnstile, so no single signal
 * dominates. Reporters whose reports keep getting dismissed weigh 0.
 */
export function reporterWeight(stats: DeviceStats, now: number): number {
  const decided = stats.upheld + stats.dismissed;
  const upheldShare = decided > 0 ? stats.upheld / decided : 0.5;
  if (stats.dismissed >= 3 && upheldShare < 0.25) return 0;
  const ageHours = stats.firstSeen === null ? 0 : Math.max(0, now - stats.firstSeen) / HOUR;
  const age = Math.min(1, ageHours / 72);
  const calls = Math.min(1, stats.completedCalls / 10);
  const w = 0.05 + 0.3 * age + 0.3 * calls + 0.35 * upheldShare;
  return Math.round(Math.min(1, Math.max(0, w)) * 1000) / 1000;
}

/** Weight of one report: the reporter's weight, halved for calls under 2 s. */
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
