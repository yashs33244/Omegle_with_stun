import { LIMITS, reportSchema, type ReportPayload } from "./protocol";
import type { ChatEntry } from "@/hooks/useSignaling";

/**
 * Report evidence captured on the reporter's device: one still frame of the
 * PARTNER's incoming video and the last chat lines. Nothing here is sent
 * until the user confirms the report; the server treats it as unverified.
 */

export type ReportEvidence = NonNullable<ReportPayload["evidence"]>;
export type EvidenceChatLine = NonNullable<ReportEvidence["chat"]>[number];

/** Longest side of the evidence frame, in pixels. */
export const EVIDENCE_FRAME_SIDE = 256;
/** JPEG qualities tried in order until the frame fits LIMITS.evidenceFrameMaxChars. */
export const EVIDENCE_QUALITIES = [0.7, 0.5, 0.3] as const;

type FrameSource = Pick<HTMLVideoElement, "videoWidth" | "videoHeight"> & CanvasImageSource;

/** Output size: the frame scaled down (never up) so its longest side is at most maxSide. */
export function evidenceSize(width: number, height: number, maxSide = EVIDENCE_FRAME_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const frameSchema = reportSchema.shape.evidence.unwrap().shape.frame.unwrap();

/**
 * The current frame of the partner's video as a small JPEG data URL, or null
 * when there is no frame (video not started, camera off) or it cannot be
 * encoded within the protocol limit. Never throws.
 */
export function captureEvidenceFrame(
  video: FrameSource | null | undefined,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): string | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  try {
    const size = evidenceSize(video.videoWidth, video.videoHeight);
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, size.width, size.height);
    for (const quality of EVIDENCE_QUALITIES) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (frameSchema.safeParse(dataUrl).success) return dataUrl;
      if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null; // no JPEG encoder
    }
    return null;
  } catch {
    // A tainted canvas or a detached video: report without the frame.
    return null;
  }
}

/** The last chat lines between the two people (system lines and undelivered messages left out). */
export function evidenceChat(messages: readonly ChatEntry[]): EvidenceChatLine[] {
  return messages
    .filter(
      (m): m is ChatEntry & { from: "me" | "partner" } =>
        (m.from === "me" || m.from === "partner") && m.delivery !== "failed",
    )
    .slice(-LIMITS.evidenceChatLinesMax)
    .map((m) => ({
      from: m.from,
      text: m.text.slice(0, LIMITS.chatMax),
      ts: Math.max(0, Math.floor(m.ts)),
    }));
}

/**
 * The evidence object for report:submit, or undefined when nothing is
 * attached. Anything the server would reject is dropped rather than
 * failing the whole report.
 */
export function buildEvidence(frame: string | null, chat: readonly EvidenceChatLine[]): ReportEvidence | undefined {
  const evidence: ReportEvidence = {};
  if (frame && frameSchema.safeParse(frame).success) evidence.frame = frame;
  if (chat.length > 0) evidence.chat = chat.slice(-LIMITS.evidenceChatLinesMax);
  if (!evidence.frame && !evidence.chat) return undefined;
  const parsed = reportSchema.shape.evidence.safeParse(evidence);
  if (parsed.success) return parsed.data;
  // Keep the frame if only the chat was rejected.
  return evidence.frame ? { frame: evidence.frame } : undefined;
}
