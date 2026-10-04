import type { ReportReason } from "@/lib/protocol";

export interface ReportChoice {
  reason: ReportReason;
  label: string;
  hint: string;
}

/** The one-tap report reasons, in plain words, mapped onto the protocol enum. */
export const REPORT_CHOICES: readonly ReportChoice[] = [
  { reason: "nudity", label: "Nudity", hint: "Sexual content or undressing" },
  { reason: "underage", label: "Minor", hint: "They look under 18" },
  { reason: "harassment", label: "Harassment or hate", hint: "Threats, bullying or slurs" },
  { reason: "spam", label: "Spam or scam", hint: "Ads, links or asking for money" },
  { reason: "fake", label: "Fake or pre-recorded video", hint: "Not a live camera" },
  { reason: "other", label: "Other", hint: "Something else" },
];
