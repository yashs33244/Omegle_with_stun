/**
 * <CaptionsOverlay captions={useCaptions(...)} />
 *
 * The partner's last two caption lines, over the bottom of the remote video
 * (position it inside the remote tile; it is absolutely placed and ignores
 * pointer events). A line fades out as it reaches FADE_MS since its last
 * update. Final lines translated on-device show the translation; untranslated
 * lines in another language carry a small "original" tag.
 * data-testid="captions-overlay"; lines are data-testid="caption-line" with
 * data-final and data-translated.
 */
import React, { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FADE_MS } from "./captionBuffer";
import { baseLanguage } from "./translator";
import type { CaptionsHandle } from "./useCaptions";

/** Opacity starts dropping this long before the line is pruned. */
const FADE_LEAD_MS = 1_000;
const TICK_MS = 500;

export interface CaptionsOverlayProps {
  captions: CaptionsHandle;
  className?: string;
}

export const CaptionsOverlay: React.FC<CaptionsOverlayProps> = ({ captions, className }) => {
  const { t } = useTranslation("spark");
  const hasLines = captions.lines.length > 0;
  // Re-render on a clock so a line's opacity follows its age between buffer updates.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!hasLines) return;
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [hasLines]);
  if (!hasLines) return null;
  const now = Date.now();
  const viewer = baseLanguage(captions.viewerLanguage);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={t("captions.overlay")}
      data-testid="captions-overlay"
      className={cn("pointer-events-none absolute inset-x-2 bottom-20 z-[7] flex flex-col items-center gap-1", className)}
    >
      {captions.lines.map((line) => {
        const fading = now - line.at >= FADE_MS - FADE_LEAD_MS;
        const foreign = baseLanguage(line.lang) !== viewer;
        const translated = line.translated !== null;
        return (
          <p
            key={line.id}
            data-testid="caption-line"
            data-final={line.final ? "1" : "0"}
            data-translated={translated ? "1" : "0"}
            className={cn(
              "max-w-full rounded-md bg-black/75 px-3 py-1 text-center text-base leading-snug text-white transition-opacity duration-1000",
              !line.final && "text-gray-200",
              fading ? "opacity-0" : "opacity-100",
            )}
          >
            {translated ? line.translated : line.text}
            {foreign && !translated && (
              <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-gray-400">{t("captions.original")}</span>
            )}
          </p>
        );
      })}
    </div>
  );
};
