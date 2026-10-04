import { useEffect, useRef, useState } from "react";
import type { Signaling } from "@/hooks/useSignaling";
import { track, trackOnce } from "@/lib/observability";
import { ClosedContent } from "./GateScreens";
import { useGate } from "./GateContext";

interface ClosedInfo {
  reopensAt: number | null;
  message: string | null;
}

export interface RoomGateOptions {
  /** Leave the room (the Home action). */
  onLeave: () => void;
  /** The WebRTC connection is up, for the call_connected funnel event. */
  connected: boolean;
}

/**
 * Gate concerns inside the call screen, kept out of Room.tsx:
 * live operator banner, restrictions applied mid-session, matching closing
 * and reopening (staffed hours, kill switch), and the match funnel events.
 * Returns an overlay to render on top of the room while matching is closed.
 */
export function useRoomGate(
  signaling: Pick<Signaling, "state" | "subscribe" | "retry">,
  { onLeave, connected }: RoomGateOptions,
): { overlay: React.ReactNode } {
  const gate = useGate();
  // Stable functions only: the context value changes whenever the config is re-read.
  const setBanner = gate?.setBanner;
  const showRestriction = gate?.showRestriction;
  const refreshConfig = gate?.refreshConfig;
  const { state, subscribe, retry } = signaling;
  const [closed, setClosed] = useState<ClosedInfo | null>(null);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  useEffect(() => {
    if (!setBanner || !showRestriction) return;
    const offs = [
      subscribe("server:banner", (p) => setBanner(p.message)),
      subscribe("session:restricted", (p) => showRestriction(p.restriction)),
      subscribe("matching:status", (p) => {
        if (!p.open) {
          setClosed({ reopensAt: p.reopensAt, message: p.message });
          return;
        }
        setClosed(null);
        // The hello was refused while closed: say hello again.
        if (statusRef.current === "error") retry();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [setBanner, showRestriction, subscribe, retry]);

  // A refused hello: find out whether matching is closed, to explain it properly.
  useEffect(() => {
    if (state.status !== "error" || !refreshConfig) return;
    let cancelled = false;
    void refreshConfig().then((config) => {
      if (!cancelled && config && !config.matchingOpen) setClosed({ reopensAt: config.reopensAt, message: null });
    });
    return () => {
      cancelled = true;
    };
  }, [state.status, refreshConfig]);

  const reopenCheck = () => {
    void refreshConfig?.().then((config) => {
      if (!config?.matchingOpen) return;
      setClosed(null);
      if (statusRef.current === "error") retry();
    });
  };

  // Funnel events.
  const prevStatus = useRef(state.status);
  useEffect(() => {
    const before = prevStatus.current;
    prevStatus.current = state.status;
    if (before === state.status) return;
    if (state.status === "match-found") trackOnce("first_match");
    // Instant mode skips "starting-call": the server accepts for us.
    if (state.status === "starting-call" || (state.status === "in-call" && before === "match-found")) {
      track("match_accepted");
    }
  }, [state.status]);

  const calls = useRef(0);
  useEffect(() => {
    if (!connected) return;
    calls.current += 1;
    track("call_connected");
    if (calls.current === 3) trackOnce("third_call");
  }, [connected]);

  const busy = state.status === "in-call" || state.status === "match-found" || state.status === "starting-call";
  const overlay =
    closed && gate && !busy ? (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chizzy is closed"
        className="fixed inset-0 z-[55] bg-black/80 flex items-center justify-center p-4"
      >
        <div className="w-full max-w-md rounded-lg border-2 border-black bg-white p-6 shadow-md text-black">
          <ClosedContent
            staffedHours={gate.config.staffedHours}
            reopensAt={closed.reopensAt}
            message={closed.message}
            onReopen={reopenCheck}
          >
            <button type="button" onClick={onLeave} className="retro-button w-full">
              Back to home
            </button>
          </ClosedContent>
        </div>
      </div>
    ) : null;

  return { overlay };
}
