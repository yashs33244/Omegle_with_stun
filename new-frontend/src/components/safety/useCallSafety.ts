import { useCallback, useEffect, useRef, useState } from "react";
import { captureEvidenceFrame, evidenceChat, type EvidenceChatLine, type ReportEvidence } from "@/lib/evidence";
import type { ChatAck, ReportAck, ReportReason, ServerToClientEvents } from "@/lib/protocol";
import type { Signaling } from "@/hooks/useSignaling";

/** Where the report was started. */
export type ReportContext = "call" | "match" | "post-call";

export type NudgeKind = Parameters<ServerToClientEvents["safety:nudge"]>[0]["kind"];

/** The person being reported, pinned to their room at the moment the user tapped Report. */
export interface ReportTarget {
  roomId: string;
  context: ReportContext;
  partnerName: string | null;
  /** Partner video frame (256 px JPEG data URL) or null when there was none. */
  frame: string | null;
  chat: EvidenceChatLine[];
}

export interface PostCall {
  roomId: string;
  partnerName: string | null;
  endedAt: number;
  frame: string | null;
  chat: EvidenceChatLine[];
}

export interface ActiveNudge {
  id: number;
  roomId: string;
  kind: NudgeKind;
}

/** The server accepts a report this long after the call ended. */
export const POST_CALL_REPORT_MS = 60_000;

/** Call ends that do not get a post-call report offer. */
const NO_POST_CALL = new Set(["reported", "restricted"]);

export type SafetySignaling = Pick<Signaling, "state" | "subscribe" | "report">;

/**
 * Report, nudge and chat-guard state for one Room. Listens through
 * signaling.subscribe so useSignaling stays untouched.
 */
export function useCallSafety(signaling: SafetySignaling, getRemoteVideo: () => HTMLVideoElement | null) {
  const { state, subscribe, report } = signaling;
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [postCall, setPostCall] = useState<PostCall | null>(null);
  const [nudge, setNudge] = useState<ActiveNudge | null>(null);
  const [roomNudge, setRoomNudge] = useState<{ roomId: string; kind: NudgeKind } | null>(null);
  const [redactedIds, setRedactedIds] = useState<ReadonlySet<string>>(() => new Set());
  const nudgeSeq = useRef(0);

  // Read inside socket handlers: the state of the last render, before the event is applied.
  const live = useRef({ state, getRemoteVideo });
  live.current = { state, getRemoteVideo };

  const addRedacted = useCallback((id: string) => {
    setRedactedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // A new room starts with a clean slate of redacted lines.
  useEffect(() => {
    setRedactedIds(new Set());
  }, [state.roomId]);

  useEffect(
    () =>
      subscribe("match:ended", ({ roomId, reason }) => {
        const { state: s, getRemoteVideo: video } = live.current;
        if (s.status !== "in-call" || s.roomId !== roomId || NO_POST_CALL.has(reason)) return;
        // Taken now, while the partner's last frame is still on screen. It stays on this device
        // and is dropped after 60 s unless the user sends a report.
        setPostCall({
          roomId,
          partnerName: s.partner?.name ?? null,
          endedAt: Date.now(),
          frame: captureEvidenceFrame(video()),
          chat: evidenceChat(s.messages),
        });
      }),
    [subscribe],
  );

  useEffect(
    () =>
      subscribe("safety:nudge", (p) => {
        nudgeSeq.current += 1;
        setNudge({ id: nudgeSeq.current, roomId: p.roomId, kind: p.kind });
        setRoomNudge({ roomId: p.roomId, kind: p.kind });
      }),
    [subscribe],
  );

  useEffect(
    () =>
      subscribe("chat:message", (p) => {
        if (p.redacted) addRedacted(p.id);
      }),
    [subscribe, addRedacted],
  );

  // The offer (and the captured frame) expires with the server's report window.
  useEffect(() => {
    if (!postCall) return;
    const t = setTimeout(
      () => setPostCall((cur) => (cur === postCall ? null : cur)),
      Math.max(0, postCall.endedAt + POST_CALL_REPORT_MS - Date.now()),
    );
    return () => clearTimeout(t);
  }, [postCall]);

  /** Opens the report sheet for the current call or match card, capturing evidence now. */
  const openReport = useCallback((context: "call" | "match") => {
    const { state: s, getRemoteVideo: video } = live.current;
    if (!s.roomId) return;
    const inCall = context === "call" && s.status === "in-call";
    setTarget({
      roomId: s.roomId,
      context,
      partnerName: s.partner?.name ?? null,
      frame: inCall ? captureEvidenceFrame(video()) : null,
      chat: inCall ? evidenceChat(s.messages) : [],
    });
  }, []);

  const postCallRef = useRef(postCall);
  postCallRef.current = postCall;
  const openPostCallReport = useCallback(() => {
    const cur = postCallRef.current;
    if (cur) setTarget({ ...cur, context: "post-call" });
  }, []);

  const closeReport = useCallback(() => setTarget(null), []);
  const dismissPostCall = useCallback(() => setPostCall(null), []);
  const dismissNudge = useCallback(() => setNudge(null), []);

  const submitReport = useCallback(
    async (roomId: string, reason: ReportReason, details?: string, evidence?: ReportEvidence): Promise<ReportAck> => {
      const res = await report(reason, details, evidence, roomId);
      if (res.ok) setPostCall((cur) => (cur?.roomId === roomId ? null : cur));
      return res;
    },
    [report],
  );

  /** Own messages: the ack says whether the partner got a redacted copy. */
  const noteChatAck = useCallback(
    (res: ChatAck) => {
      if (res.ok && res.redacted) addRedacted(res.id);
    },
    [addRedacted],
  );

  return {
    target,
    openReport,
    openPostCallReport,
    closeReport,
    submitReport,
    postCall,
    dismissPostCall,
    nudge,
    dismissNudge,
    /** The latest nudge for the current room, for the inline chat notice. */
    chatNudge: roomNudge && roomNudge.roomId === state.roomId ? roomNudge.kind : null,
    redactedIds,
    noteChatAck,
  };
}

export type CallSafety = ReturnType<typeof useCallSafety>;
