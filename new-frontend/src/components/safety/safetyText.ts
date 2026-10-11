import type { ReportAck } from "@/lib/protocol";
import type { NudgeKind } from "./useCallSafety";

/** Nudge copy keys in the `safety` namespace: informative, never punitive. */
export const NUDGE_KEYS = {
  "contact-sharing": { title: "nudges.contactSharing.title", body: "nudges.contactSharing.body" },
  solicitation: { title: "nudges.solicitation.title", body: "nudges.solicitation.body" },
  "link-hidden": { title: "nudges.linkHidden.title", body: "nudges.linkHidden.body" },
} as const satisfies Record<NudgeKind, { title: string; body: string }>;

export type ReportErrorKey = { key: "reportError.notInRoom" | "reportError.rateLimited" | "reportError.invalidPayload" | "reportError.generic" } | { key: "reportError.withMessage"; values: { message: string } };

/** Plain-language text for a failed report ack, as a `safety` namespace key. */
export function reportErrorKey(res: Extract<ReportAck, { ok: false }>): ReportErrorKey {
  switch (res.error) {
    case "not_in_room":
      return { key: "reportError.notInRoom" };
    case "rate_limited":
      return { key: "reportError.rateLimited" };
    case "invalid_payload":
      return { key: "reportError.invalidPayload" };
    default:
      return res.message ? { key: "reportError.withMessage", values: { message: res.message } } : { key: "reportError.generic" };
  }
}

export const SAFETY_COACH_KEY = "chizzy.safetyCoachSeen";

export function hasSeenSafetyCoach(): boolean {
  try {
    return window.localStorage.getItem(SAFETY_COACH_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSafetyCoachSeen(): void {
  try {
    window.localStorage.setItem(SAFETY_COACH_KEY, "1");
  } catch {
    // Private mode: the card shows again next time, which is fine.
  }
}
