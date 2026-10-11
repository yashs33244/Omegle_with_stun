/**
 * Live captions for one call, both directions:
 * - my own speech -> useSpeechCaptions -> caption:segment to the server (relayed to the partner);
 * - the partner's caption:segment -> buffer -> on-device translation of final
 *   segments into my language where the browser can -> <CaptionsOverlay>.
 *
 * Text flows only while this side has captions on: with the toggle off no
 * recogniser runs and incoming segments are dropped. The choice is remembered
 * on this device. Call once per room screen and hand the result to
 * <CaptionsToggle> and <CaptionsOverlay>.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Signaling } from "@/hooks/useSignaling";
import { captionBufferReducer, initialCaptionBuffer, type CaptionLine } from "./captionBuffer";
import { baseLanguage, getTranslator } from "./translator";
import { useSpeechCaptions } from "./useSpeechCaptions";

export const CAPTIONS_KEY = "chizzy.captions";
export const CAPTIONS_NOTICE_KEY = "chizzy.captions.notice";
const PRUNE_EVERY_MS = 500;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

export interface UseCaptionsOptions {
  signaling: Pick<Signaling, "subscribe" | "send">;
  /** The active call's room, or null outside a call. */
  roomId: string | null;
  localStream: MediaStream | null;
  /** The mic toggle; captions pause while muted. */
  micEnabled: boolean;
  /** The partner's "I speak" language; translation source until their segments say otherwise. */
  partnerLanguage: string | null;
  /** My "I speak" language: what the recogniser listens for and what the partner's text is translated into. */
  viewerLanguage: string;
}

export interface CaptionsHandle {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** The browser has SpeechRecognition; otherwise the toggle is disabled. */
  supported: boolean;
  /** My recogniser is running right now. */
  listening: boolean;
  /** The partner's lines, oldest first. */
  lines: CaptionLine[];
  viewerLanguage: string;
  /** First-use privacy notice: shown once, when the user first turns captions on. */
  noticeOpen: boolean;
  dismissNotice: () => void;
}

export function useCaptions({
  signaling,
  roomId,
  localStream,
  micEnabled,
  partnerLanguage,
  viewerLanguage,
}: UseCaptionsOptions): CaptionsHandle {
  const [enabled, setEnabledState] = useState(() => read(CAPTIONS_KEY) === "1");
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [buffer, dispatch] = useReducer(captionBufferReducer, initialCaptionBuffer);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const setEnabled = useCallback((next: boolean) => {
    write(CAPTIONS_KEY, next ? "1" : "0");
    setEnabledState(next);
    if (next && read(CAPTIONS_NOTICE_KEY) !== "1") setNoticeOpen(true);
    if (!next) setNoticeOpen(false);
  }, []);

  const dismissNotice = useCallback(() => {
    write(CAPTIONS_NOTICE_KEY, "1");
    setNoticeOpen(false);
  }, []);

  const speech = useSpeechCaptions(localStream, viewerLanguage, {
    enabled: enabled && micEnabled && roomId !== null,
    onSegment: (segment) => {
      const room = roomRef.current;
      if (room) signaling.send("caption:segment", { roomId: room, ...segment });
    },
  });

  // Partner lines: a new room (or none) starts empty.
  useEffect(() => {
    dispatch({ type: "clear" });
  }, [roomId]);

  const target = baseLanguage(viewerLanguage);
  useEffect(
    () =>
      signaling.subscribe("caption:segment", (segment) => {
        if (!enabledRef.current || segment.roomId !== roomRef.current) return;
        dispatch({ type: "segment", segment, now: Date.now() });
        if (!segment.final || baseLanguage(segment.lang) === target) return;
        void getTranslator(segment.lang, target).then(async (translator) => {
          if (!translator) return;
          try {
            const text = await translator.translate(segment.text);
            if (text.trim() && segment.roomId === roomRef.current) dispatch({ type: "translated", id: segment.id, text });
          } catch {
            // Keep the original; the overlay tags it as such.
          }
        });
      }),
    [signaling, target],
  );

  // Warm the translator for the pair as soon as the partner is known, so the first final line does not wait.
  useEffect(() => {
    if (enabled && partnerLanguage) void getTranslator(partnerLanguage, target);
  }, [enabled, partnerLanguage, target]);

  // Lines leave FADE_MS after their last update.
  const hasLines = buffer.lines.length > 0;
  useEffect(() => {
    if (!hasLines) return;
    const timer = setInterval(() => dispatch({ type: "prune", now: Date.now() }), PRUNE_EVERY_MS);
    return () => clearInterval(timer);
  }, [hasLines]);

  return {
    enabled,
    setEnabled,
    supported: speech.supported,
    listening: speech.listening,
    lines: enabled ? buffer.lines : [],
    viewerLanguage,
    noticeOpen,
    dismissNotice,
  };
}
