/**
 * Transcribes the user's OWN speech with the browser's SpeechRecognition
 * (continuous, interim results) and hands out segments {id, text, final, lang}.
 *
 * Runs only while `enabled` and the local stream has a live, enabled audio
 * track (the toggle is on and the mic is not muted). Chrome ends a session
 * after silence, so the recogniser restarts on `end` until stopped. Interim
 * results for one segment go out at most every CAPTIONS.interimEveryMs;
 * finals go out at once.
 */
import { useEffect, useRef, useState } from "react";
import { CAPTIONS } from "@/lib/protocol";
import { speechRecognition, speechTag, type SpeechRecognitionLike } from "./speech";

export interface SpeechSegment {
  id: string;
  text: string;
  final: boolean;
  lang: string;
}

export interface UseSpeechCaptionsOptions {
  enabled: boolean;
  onSegment: (segment: SpeechSegment) => void;
}

export interface SpeechCaptionsState {
  /** The browser has SpeechRecognition. */
  supported: boolean;
  /** A recogniser is running. */
  listening: boolean;
  /** Last fatal recogniser error ("not-allowed", ...), null when fine. */
  error: string | null;
}

/** Errors after which restarting is pointless until the user changes something. */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported", "audio-capture"]);
const RESTART_DELAY_MS = 300;

function hasLiveAudio(stream: MediaStream | null): boolean {
  return stream?.getAudioTracks().some((track) => track.readyState === "live" && track.enabled) ?? false;
}

export function useSpeechCaptions(
  localStream: MediaStream | null,
  language: string,
  { enabled, onSegment }: UseSpeechCaptionsOptions,
): SpeechCaptionsState {
  const supported = speechRecognition() !== null;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const audioTracks = localStream?.getAudioTracks().length ?? 0;
  const active = enabled && supported && hasLiveAudio(localStream);

  useEffect(() => {
    const Ctor = speechRecognition();
    if (!active || !Ctor) {
      setListening(false);
      return;
    }
    let stopped = false;
    let recognizer: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    // One prefix per recogniser session, so result indexes never collide across restarts.
    let session = 0;
    /** Per segment: when the last interim went out and the latest text not yet sent. */
    const interim = new Map<string, { sentAt: number; timer?: ReturnType<typeof setTimeout> }>();

    const emit = (segment: SpeechSegment) => {
      if (!stopped) onSegmentRef.current(segment);
    };

    const start = () => {
      if (stopped) return;
      session += 1;
      const sessionId = `${Date.now().toString(36)}-${session}`;
      const r = new Ctor();
      r.lang = speechTag(language);
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (!result) continue;
          const text = result[0]?.transcript.trim() ?? "";
          if (!text) continue;
          const id = `${sessionId}-${i}`;
          const segment: SpeechSegment = { id, text, final: result.isFinal, lang: language };
          const pending = interim.get(id);
          if (result.isFinal) {
            if (pending?.timer) clearTimeout(pending.timer);
            interim.delete(id);
            emit(segment);
            continue;
          }
          const now = Date.now();
          const due = (pending?.sentAt ?? 0) + CAPTIONS.interimEveryMs;
          if (now >= due) {
            if (pending?.timer) clearTimeout(pending.timer);
            interim.set(id, { sentAt: now });
            emit(segment);
          } else if (!pending?.timer) {
            const timer = setTimeout(() => {
              interim.set(id, { sentAt: Date.now() });
              emit(segment);
            }, due - now);
            interim.set(id, { sentAt: pending?.sentAt ?? 0, timer });
          }
        }
      };
      r.onerror = (event) => {
        if (FATAL_ERRORS.has(event.error)) {
          setError(event.error);
          stopped = true;
          setListening(false);
        }
      };
      r.onend = () => {
        recognizer = null;
        if (stopped) return;
        restartTimer = setTimeout(start, RESTART_DELAY_MS);
      };
      recognizer = r;
      try {
        r.start();
        setError(null);
        setListening(true);
      } catch {
        // start() throws when a session is already running; the onend restart covers it.
      }
    };

    start();
    return () => {
      stopped = true;
      clearTimeout(restartTimer);
      for (const entry of interim.values()) clearTimeout(entry.timer);
      interim.clear();
      recognizer?.abort();
      setListening(false);
    };
    // audioTracks re-arms the recogniser when the stream gains or loses its mic.
  }, [active, language, audioTracks]);

  return { supported, listening, error };
}
