/**
 * Spark for one call: asks the server for a prompt, mirrors spark:show into
 * the card both sides see, and loads the prompt text in the UI language.
 *
 * Call once per room screen and hand the result to <SparkButton> and <SparkCard>.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Signaling } from "@/hooks/useSignaling";
import { toLang } from "@/lib/i18n";
import { SPARK } from "@/lib/protocol";
import { loadPrompts, type PromptTexts } from "./prompts";
import { canRequest, initialSparkState, sparkReducer, type SparkCard } from "./sparkReducer";

export interface UseSparkOptions {
  signaling: Pick<Signaling, "subscribe" | "request">;
  /** The active call's room, or null outside a call (the button then does nothing). */
  roomId: string | null;
}

export interface SparkHandle {
  card: SparkCard | null;
  /** Prompt text for the card in the UI language; null while loading, "" when the catalog failed to load. */
  text: string | null;
  /** Local clock until which requests are refused; 0 when ready. */
  cooldownUntil: number;
  pending: boolean;
  /** Inside a call with nothing in flight. The cooldown is separate: compare cooldownUntil with the clock. */
  ready: boolean;
  request: () => void;
  dismiss: () => void;
}

export function useSpark({ signaling, roomId }: UseSparkOptions): SparkHandle {
  const { i18n } = useTranslation();
  const [state, dispatch] = useReducer(sparkReducer, initialSparkState);
  const [texts, setTexts] = useState<PromptTexts | null>(null);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const stateRef = useRef(state);
  stateRef.current = state;

  // A new room (or none) starts clean: no stale card, no inherited cooldown.
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [roomId]);

  useEffect(
    () =>
      signaling.subscribe("spark:show", (show) => {
        if (show.roomId === roomRef.current) dispatch({ type: "show", show, now: Date.now() });
      }),
    [signaling],
  );

  useEffect(() => {
    if (!state.card) return;
    const timer = setTimeout(() => dispatch({ type: "expire", now: Date.now() }), SPARK.cardMs);
    return () => clearTimeout(timer);
  }, [state.card]);

  const lang = toLang(i18n.resolvedLanguage ?? i18n.language);
  useEffect(() => {
    let cancelled = false;
    setTexts(null);
    void loadPrompts(lang).then((loaded) => {
      if (!cancelled) setTexts(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const request = useCallback(() => {
    const room = roomRef.current;
    const now = Date.now();
    if (!room || !canRequest(stateRef.current, now)) return;
    dispatch({ type: "request", now });
    void signaling.request("spark:request", { roomId: room }).then((ack) => {
      if (ack.ok) dispatch({ type: "ack", ok: true, now: Date.now() });
      else dispatch({ type: "ack", ok: false, error: ack.error, now: Date.now() });
    });
  }, [signaling]);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  const text = state.card ? (texts ? (texts[state.card.promptId] ?? "") : null) : null;
  return {
    card: state.card,
    text,
    cooldownUntil: state.cooldownUntil,
    pending: state.pending,
    ready: roomId !== null && !state.pending,
    request,
    dismiss,
  };
}
