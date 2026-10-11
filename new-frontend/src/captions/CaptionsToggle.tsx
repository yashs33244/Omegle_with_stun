/**
 * <CaptionsToggle captions={useCaptions(...)} />
 *
 * A 56 px CC button (aria-pressed) that turns live captions on and off; the
 * choice is remembered on the device. Disabled with a "Captions need Chrome"
 * tooltip where the browser has no SpeechRecognition. The first time captions
 * go on, a small privacy notice opens above the button until dismissed.
 * data-testid="captions-toggle"; the notice is data-testid="captions-notice".
 */
import React from "react";
import { Captions } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CaptionsHandle } from "./useCaptions";

export interface CaptionsToggleProps {
  captions: CaptionsHandle;
  className?: string;
}

export const CaptionsToggle: React.FC<CaptionsToggleProps> = ({ captions, className }) => {
  const { t } = useTranslation("spark");
  const { enabled, supported, listening, noticeOpen } = captions;
  const title = !supported ? t("captions.unsupported") : enabled ? t("captions.on") : t("captions.off");

  return (
    <span className={cn("relative inline-flex", className)} title={title}>
      <button
        type="button"
        onClick={() => captions.setEnabled(!enabled)}
        disabled={!supported}
        aria-pressed={enabled}
        aria-label={t("captions.toggle")}
        aria-describedby={noticeOpen ? "captions-notice" : undefined}
        title={title}
        data-testid="captions-toggle"
        data-listening={listening ? "1" : undefined}
        className={cn(
          "relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-black shadow-[0_3px_0_#000] transition-colors max-[379px]:h-12 max-[379px]:w-12",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50",
          enabled ? "bg-yellow-400 text-black hover:bg-yellow-300" : "bg-black/60 text-white hover:bg-gray-800",
        )}
      >
        <Captions className="h-6 w-6" aria-hidden="true" />
        {enabled && listening && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-black bg-red-500" aria-hidden="true" />
        )}
      </button>
      {noticeOpen && (
        // Hangs from the button's right edge (the button sits near the screen edge); on landscape phones it opens to the left of the rail.
        <div
          id="captions-notice"
          role="note"
          data-testid="captions-notice"
          className="absolute bottom-full right-0 z-[30] mb-2 w-[min(16rem,calc(100vw-1.5rem))] rounded-xl border-2 border-black bg-gray-900 p-3 text-sm text-white shadow-[3px_3px_0_0_#000] max-lg:landscape:bottom-auto max-lg:landscape:right-full max-lg:landscape:top-1/2 max-lg:landscape:mb-0 max-lg:landscape:mr-2 max-lg:landscape:-translate-y-1/2"
        >
          <p>{t("captions.privacy")}</p>
          <button
            type="button"
            onClick={captions.dismissNotice}
            data-testid="captions-notice-ok"
            className="mt-2 min-h-[36px] rounded-md bg-yellow-400 px-3 py-1 font-medium text-black hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-white"
          >
            {t("captions.gotIt")}
          </button>
        </div>
      )}
    </span>
  );
};
