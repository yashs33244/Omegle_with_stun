import type { ReportAck } from "@/lib/protocol";
import type { NudgeKind } from "./useCallSafety";

/** Nudge copy: informative, never punitive. */
export const NUDGE_TEXT: Record<NudgeKind, { title: string; body: string }> = {
  "contact-sharing": {
    title: "Thinking of moving to another app?",
    body: "Anyone can record their screen. You do not have to share your contacts with a stranger, and you can report them.",
  },
  solicitation: {
    title: "You do not have to do anything you are not comfortable with",
    body: "Never undress for a stranger. If someone threatens you, do not pay; report it. You can leave with Skip at any time.",
  },
  "link-hidden": {
    title: "Link hidden for safety",
    body: "Links, handles and phone numbers are hidden in the first minutes of a call.",
  },
};

/** Plain-language text for a failed report ack. */
export function reportErrorText(res: Extract<ReportAck, { ok: false }>): string {
  switch (res.error) {
    case "not_in_room":
      return "This call can no longer be reported. Reports are accepted during a call and for 60 seconds after it.";
    case "rate_limited":
      return "You have sent several reports recently. Please wait a little and try again.";
    case "invalid_payload":
      return "The report was not accepted. Try again without the attachments.";
    default:
      return res.message ? `The report could not be sent: ${res.message}` : "The report could not be sent. Please try again.";
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
