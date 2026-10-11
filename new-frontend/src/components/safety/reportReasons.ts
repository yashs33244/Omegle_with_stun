import type { ReportReason } from "@/lib/protocol";

export interface ReportChoice {
  reason: ReportReason;
  labelKey: `reportReasons.${ReportReason}.label`;
  hintKey: `reportReasons.${ReportReason}.hint`;
}

/** The one-tap report reasons, mapped onto the protocol enum; keys live in the `safety` namespace. */
export const REPORT_CHOICES = [
  { reason: "nudity", labelKey: "reportReasons.nudity.label", hintKey: "reportReasons.nudity.hint" },
  { reason: "underage", labelKey: "reportReasons.underage.label", hintKey: "reportReasons.underage.hint" },
  { reason: "harassment", labelKey: "reportReasons.harassment.label", hintKey: "reportReasons.harassment.hint" },
  { reason: "spam", labelKey: "reportReasons.spam.label", hintKey: "reportReasons.spam.hint" },
  { reason: "fake", labelKey: "reportReasons.fake.label", hintKey: "reportReasons.fake.hint" },
  { reason: "other", labelKey: "reportReasons.other.label", hintKey: "reportReasons.other.hint" },
] as const satisfies readonly ReportChoice[];
