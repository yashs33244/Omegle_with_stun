import React, { useEffect } from "react";
import { ShieldAlert, X } from "lucide-react";
import { NUDGE_TEXT } from "./safetyText";
import type { ActiveNudge } from "./useCallSafety";

const NUDGE_TTL_MS = 15_000;

interface NudgeToastProps {
  nudge: ActiveNudge;
  onDismiss: () => void;
  /** Offered for contact-sharing and solicitation nudges while the call is on. */
  onReport?: () => void;
}

export const NudgeToast: React.FC<NudgeToastProps> = ({ nudge, onDismiss, onReport }) => {
  useEffect(() => {
    const t = setTimeout(onDismiss, NUDGE_TTL_MS);
    return () => clearTimeout(t);
  }, [nudge.id, onDismiss]);

  const text = NUDGE_TEXT[nudge.kind];
  const showReport = onReport && nudge.kind !== "link-hidden";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="nudge-toast"
      data-kind={nudge.kind}
      className="fixed left-1/2 top-20 z-[70] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-lg border-2 border-yellow-400 bg-gray-900/95 p-3 text-white shadow-xl"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{text.title}</p>
          <p className="mt-1 text-sm text-gray-300">{text.body}</p>
          {showReport && (
            <button
              type="button"
              onClick={onReport}
              className="mt-2 rounded-md bg-red-600 px-3 py-1 text-sm font-medium hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            >
              Report
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss safety tip"
          className="rounded p-1 text-gray-300 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
